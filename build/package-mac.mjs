/**
 * Builds the macOS app (.app inside a .dmg) from the official Electron
 * darwin distribution, mirroring build/package-win.mjs.
 *
 * MUST run on macOS (e.g. a GitHub Actions `macos-latest` runner): it relies on
 * ditto (zip handling that preserves the symlinks inside Electron.app),
 * plutil/PlistBuddy (Info.plist), sips + iconutil (icns icon), codesign
 * (ad-hoc signature — without it Apple Silicon refuses to launch the modified
 * app) and hdiutil (.dmg).
 *
 * Usage: node build/package-mac.mjs [arm64|x64|all]   (default: all)
 *   arm64 → Apple Silicon (M1/M2/M3…)   x64 → Macs Intel
 */
import { createWriteStream } from "node:fs";
import { mkdir, rm, cp, readFile, writeFile, rename, stat, readdir, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("Este script solo funciona en macOS (necesita ditto/hdiutil/codesign).");
  console.error("Ejecútalo en una Mac o en GitHub Actions con runs-on: macos-latest.");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "build", ".cache");
const distDir = join(root, "dist");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const ELECTRON_VERSION = pkg.devDependencies.electron.replace(/^[^0-9]*/, "");
const APP_NAME = "Itappi Tracking Agent";
const BUNDLE_ID = "com.itappi.tracking-agent";

const requested = process.argv[2] || "all";
const ARCHS = requested === "all" ? ["arm64", "x64"] : [requested];
if (!ARCHS.every((a) => ["arm64", "x64"].includes(a))) {
  console.error(`Arquitectura desconocida: ${requested} (usa arm64, x64 o all)`);
  process.exit(1);
}

const baseUrl = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
const log = (msg) => console.log(`  ${msg}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Descarga falló (${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// --- icon: PNG → .icns (shared across archs) --------------------------------

async function buildIcns() {
  const icnsPath = join(cacheDir, "icon.icns");
  if (await exists(icnsPath)) return icnsPath;

  log("Generando icono .icns…");
  const iconset = join(cacheDir, "icon.iconset");
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  const src = join(root, "assets", "icon.png");
  for (const size of [16, 32, 64, 128, 256, 512]) {
    run("sips", ["-z", `${size}`, `${size}`, src, "--out", join(iconset, `icon_${size}x${size}.png`)]);
    run("sips", ["-z", `${size * 2}`, `${size * 2}`, src, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", icnsPath]);
  return icnsPath;
}

// --- build one architecture --------------------------------------------------

async function buildArch(arch) {
  const zipName = `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`;
  const outName = `ItappiTrackingAgent-${pkg.version}-mac-${arch}`;
  console.log(`\nEmpaquetando para darwin-${arch}…`);

  // 1. fetch + verify the official Electron build
  await mkdir(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, zipName);
  if (await exists(zipPath)) {
    log(`Electron ${ELECTRON_VERSION} (${arch}) ya en caché`);
  } else {
    log(`Descargando Electron ${ELECTRON_VERSION} (darwin-${arch})…`);
    await download(`${baseUrl}/${zipName}`, zipPath);
  }

  log("Verificando SHA256…");
  const shasumsPath = join(cacheDir, `SHASUMS256-${ELECTRON_VERSION}.txt`);
  if (!(await exists(shasumsPath))) {
    await download(`${baseUrl}/SHASUMS256.txt`, shasumsPath);
  }
  const shasums = await readFile(shasumsPath, "utf8");
  const expected = shasums
    .split("\n")
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === zipName)?.[0];
  if (!expected) throw new Error(`No hay checksum publicado para ${zipName}`);
  const actual = await sha256(zipPath);
  if (actual !== expected) {
    throw new Error(`Checksum incorrecto para ${zipName}\n  esperado: ${expected}\n  obtenido: ${actual}`);
  }
  log(`SHA256 correcto (${expected.slice(0, 16)}…)`);

  // 2. extract — ditto preserves the symlinks inside Electron.app, which
  // python's zipfile (used by the win script) would destroy.
  const stage = join(distDir, outName);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  log("Extrayendo distribución de Electron…");
  run("ditto", ["-x", "-k", zipPath, stage]);

  const appPath = join(stage, `${APP_NAME}.app`);
  await rename(join(stage, "Electron.app"), appPath);
  const contents = join(appPath, "Contents");
  const resources = join(contents, "Resources");

  // The stock binary boots Electron's "welcome" app; removing it makes our
  // resources/app the entry point.
  await rm(join(resources, "default_app.asar"), { force: true });

  // 3. lay out the app
  log("Copiando la aplicación…");
  const appResources = join(resources, "app");
  await mkdir(appResources, { recursive: true });
  for (const entry of ["src", "ui", "assets"]) {
    await cp(join(root, entry), join(appResources, entry), { recursive: true });
  }
  await writeFile(
    join(appResources, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        description: pkg.description,
        main: pkg.main,
        dependencies: pkg.dependencies,
      },
      null,
      2
    ),
    "utf8"
  );

  log("Resolviendo dependencias de producción…");
  const listed = run("npm", ["ls", "--omit=dev", "--all", "--parseable"], { cwd: root })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(`${sep}node_modules${sep}`));
  if (listed.length === 0) throw new Error("npm ls no devolvió dependencias de producción");
  for (const modulePath of listed) {
    const relative = modulePath.slice(modulePath.indexOf(`${sep}node_modules${sep}`) + 1);
    await cp(modulePath, join(appResources, relative), { recursive: true });
  }
  log(`${listed.length} paquete(s) de producción incluidos`);

  const prebuilds = join(appResources, "node_modules", "uiohook-napi", "prebuilds");
  const keep = `darwin-${arch}`;
  if (await exists(prebuilds)) {
    for (const platform of await readdir(prebuilds)) {
      if (platform !== keep) await rm(join(prebuilds, platform), { recursive: true, force: true });
    }
    if (!(await exists(join(prebuilds, keep)))) {
      throw new Error(`Falta el binario nativo ${keep} de uiohook-napi`);
    }
    log(`Binario nativo ${keep} incluido (captura de teclado/ratón)`);
  }

  // 4. brand the bundle: Info.plist, executable name, icon
  log("Aplicando nombre, versión e icono al .app…");
  const plist = join(contents, "Info.plist");
  const set = (key, value) => run("plutil", ["-replace", key, "-string", value, plist]);
  set("CFBundleName", APP_NAME);
  set("CFBundleDisplayName", APP_NAME);
  set("CFBundleIdentifier", BUNDLE_ID);
  set("CFBundleExecutable", APP_NAME);
  set("CFBundleShortVersionString", pkg.version);
  set("CFBundleVersion", pkg.version);
  await rename(join(contents, "MacOS", "Electron"), join(contents, "MacOS", APP_NAME));
  // CFBundleIconFile already points to electron.icns — overwrite it in place
  await cp(await buildIcns(), join(resources, "electron.icns"));

  // 5. ad-hoc signature — mandatory: we modified the bundle, and Apple Silicon
  // kills apps whose signature is missing or stale. "-" = sin certificado.
  log("Firmando (ad-hoc)…");
  run("codesign", ["--force", "--deep", "--sign", "-", appPath]);

  // 6. LEEME + .dmg
  await writeFile(
    join(stage, "LEEME.txt"),
    [
      "Itappi Tracking Agent para macOS",
      "================================",
      "",
      `Version ${pkg.version} (${arch === "arm64" ? "Apple Silicon: M1/M2/M3…" : "Macs Intel"})`,
      "",
      "COMO INSTALARLO",
      "---------------",
      "1. Arrastra 'Itappi Tracking Agent' a la carpeta Aplicaciones.",
      "2. La PRIMERA vez: clic derecho sobre la app > Abrir > Abrir.",
      "   Si macOS dice que no puede verificar al desarrollador y no ofrece",
      "   'Abrir', ve a Ajustes del Sistema > Privacidad y seguridad y pulsa",
      "   'Abrir de todos modos'. (La app aun no esta firmada con certificado",
      "   de Apple; este aviso es esperado.)",
      "3. Introduce la URL de tu servidor de tracking, tu correo y tu contrasena.",
      "",
      "PERMISOS NECESARIOS",
      "-------------------",
      "Para contar pulsaciones y clics, macOS pedira permisos la primera vez:",
      "Ajustes del Sistema > Privacidad y seguridad >",
      "  - Monitoreo de entrada: activar 'Itappi Tracking Agent'",
      "  - Accesibilidad: activar 'Itappi Tracking Agent'",
      "Despues de activarlos, cierra y vuelve a abrir la app.",
      "",
      "QUE REGISTRA",
      "------------",
      "- Tiempo trabajado (cronometro, descontando inactividad).",
      "- Numero de pulsaciones de teclas, clics y movimiento del raton por minuto.",
      "",
      "NO registra que teclas pulsas, ni textos, ni capturas de pantalla, ni que",
      "aplicaciones o webs usas.",
      "",
    ].join("\r\n"),
    "utf8"
  );
  await symlink("/Applications", join(stage, "Aplicaciones"));

  log("Creando .dmg…");
  const dmgOut = join(distDir, `${outName}.dmg`);
  await rm(dmgOut, { force: true });
  run("hdiutil", ["create", "-volname", APP_NAME, "-srcfolder", stage, "-ov", "-format", "UDZO", dmgOut]);

  const dmgSize = (await stat(dmgOut)).size;
  console.log(`  Listo: ${dmgOut} (${(dmgSize / 1024 / 1024).toFixed(1)} MB)`);
  return dmgOut;
}

const outputs = [];
for (const arch of ARCHS) {
  outputs.push(await buildArch(arch));
}

console.log("\n  Todo listo:");
for (const out of outputs) console.log(`    ${out}`);
