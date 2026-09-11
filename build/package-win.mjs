/**
 * Builds a runnable Windows x64 app from Linux, without wine.
 *
 * electron-builder's NSIS installer target shells out to wine on Linux, and
 * @electron/packager shells out to rcedit (also wine) to brand the binary. This
 * script avoids both: it assembles the official Electron win32 distribution by
 * hand and rewrites the PE resources with `resedit`, which is pure JavaScript.
 *
 * Requires python3 for zip handling (stdlib zipfile) — no unzip/zip binary
 * needed. Run: npm run package:win
 */
import { createWriteStream } from "node:fs";
import { mkdir, rm, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAppResources } from "./lib/stage-app.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "build", ".cache");
const distDir = join(root, "dist");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const ELECTRON_VERSION = pkg.devDependencies.electron.replace(/^[^0-9]*/, "");
const ARCH = "win32-x64";
const EXE_NAME = "ItappiTrackingAgent.exe";
const OUT_NAME = `ItappiTrackingAgent-${pkg.version}-win-x64`;

const zipName = `electron-v${ELECTRON_VERSION}-${ARCH}.zip`;
const baseUrl = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;

const log = (msg) => console.log(`  ${msg}`);

/** Extraction and archive creation via python3's zipfile — always present on
 *  this build host, unlike unzip/zip. */
function python(code) {
  return execFileSync("python3", ["-c", code], { encoding: "utf8", maxBuffer: 1 << 28 });
}

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

// --- 1. fetch the official Electron build ----------------------------------

await mkdir(cacheDir, { recursive: true });
const zipPath = join(cacheDir, zipName);

if (await exists(zipPath)) {
  log(`Electron ${ELECTRON_VERSION} ya en caché`);
} else {
  log(`Descargando Electron ${ELECTRON_VERSION} (${ARCH})…`);
  await download(`${baseUrl}/${zipName}`, zipPath);
}

// Verify against the release checksums: this binary is about to run on an
// employee's machine, so a silently corrupted or swapped download is not an
// acceptable failure mode.
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

// --- 2. lay out the app ----------------------------------------------------

const appDir = join(distDir, OUT_NAME);
await rm(appDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

log("Extrayendo distribución de Electron…");
python(`
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}) as z:
    z.extractall(${JSON.stringify(appDir)})
`);

// The stock binary boots Electron's "welcome" app; removing it makes our
// resources/app the entry point.
await rm(join(appDir, "resources", "default_app.asar"), { force: true });

log("Copiando la aplicación…");
const appResources = join(appDir, "resources", "app");
const { depCount } = await stageAppResources(root, appResources, "win32-x64");
log(`${depCount} paquete(s) de producción incluidos (binario nativo win32-x64 de uiohook-napi entre ellos)`);

// --- 3. brand the executable ----------------------------------------------

const exePath = join(appDir, EXE_NAME);
await rename(join(appDir, "electron.exe"), exePath);

log("Aplicando icono y metadatos al .exe…");
const { NtExecutable, NtExecutableResource, Data, Resource } = await import("resedit");

const exeData = await readFile(exePath);
const executable = NtExecutable.from(exeData);
const resource = NtExecutableResource.from(executable);

const icoBuffer = await readFile(join(root, "assets", "icon.ico"));
const iconFile = Data.IconFile.from(icoBuffer);
Resource.IconGroupEntry.replaceIconsForResource(
  resource.entries,
  1,
  1033, // en-US: the language id the stock Electron resources already use
  iconFile.icons.map((item) => item.data)
);

const versionInfo = Resource.VersionInfo.fromEntries(resource.entries)[0];
const [major, minor, patch] = pkg.version.split(".").map((n) => parseInt(n, 10) || 0);
versionInfo.setFileVersion(major, minor, patch, 0);
versionInfo.setProductVersion(major, minor, patch, 0);
versionInfo.setStringValues(
  { lang: 1033, codepage: 1200 },
  {
    ProductName: pkg.productName,
    FileDescription: pkg.description,
    CompanyName: "Itappi",
    LegalCopyright: `© ${pkg.author || "Itappi"}`,
    OriginalFilename: EXE_NAME,
    InternalName: pkg.name,
  }
);
versionInfo.outputToResourceEntries(resource.entries);

resource.outputResource(executable);
await writeFile(exePath, Buffer.from(executable.generate()));

// --- 4. instructions + archive --------------------------------------------

await writeFile(
  join(appDir, "LEEME.txt"),
  [
    "Itappi Tracking Agent",
    "=====================",
    "",
    `Version ${pkg.version}`,
    "",
    "COMO USARLO",
    "-----------",
    "1. Descomprime esta carpeta COMPLETA donde quieras (por ejemplo",
    "   C:\\Program Files\\Itappi Tracking Agent o el Escritorio).",
    `2. Ejecuta ${EXE_NAME}.`,
    "3. Introduce la URL de tu servidor de tracking, tu correo y tu contrasena.",
    "4. Pulsa Iniciar. El agente queda en la bandeja del sistema (junto al reloj).",
    "",
    "IMPORTANTE: no muevas el .exe fuera de esta carpeta. Necesita los archivos",
    "que estan junto a el para funcionar.",
    "",
    "QUE REGISTRA",
    "------------",
    "- Tiempo trabajado (cronometro, descontando inactividad).",
    "- Numero de pulsaciones de teclas, clics y movimiento del raton por minuto.",
    "",
    "NO registra que teclas pulsas, ni textos, ni capturas de pantalla, ni que",
    "aplicaciones o webs usas.",
    "",
    "AVISOS DE WINDOWS",
    "-----------------",
    "Al no estar firmado digitalmente, Windows SmartScreen puede mostrar un aviso",
    "la primera vez. Elige 'Mas informacion' > 'Ejecutar de todas formas'.",
    "El antivirus puede senalar la captura global de teclado; es la funcion que",
    "cuenta las pulsaciones, y es esperado en un agente de este tipo.",
    "",
  ].join("\r\n"),
  "utf8"
);

log("Comprimiendo…");
const zipOut = join(distDir, `${OUT_NAME}.zip`);
await rm(zipOut, { force: true });
python(`
import os, zipfile
src = ${JSON.stringify(appDir)}
out = ${JSON.stringify(zipOut)}
root_name = ${JSON.stringify(OUT_NAME)}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for folder, _, files in os.walk(src):
        for f in files:
            full = os.path.join(folder, f)
            rel = os.path.relpath(full, src)
            z.write(full, os.path.join(root_name, rel))
`);

const zipSize = (await stat(zipOut)).size;
const exeSize = (await stat(exePath)).size;

console.log("");
console.log("  Listo.");
console.log(`    Carpeta : ${appDir}`);
console.log(`    ZIP     : ${zipOut}  (${(zipSize / 1024 / 1024).toFixed(1)} MB)`);
console.log(`    Ejecutable: ${EXE_NAME}  (${(exeSize / 1024 / 1024).toFixed(1)} MB)`);
