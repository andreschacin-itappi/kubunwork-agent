/**
 * Builds the lightweight artifact the silent auto-updater downloads: just
 * `resources/app` (src/ui/assets/package.json/node_modules), zipped flat —
 * NOT the full ~200 MB Electron runtime that package-win.mjs produces. Most
 * releases only touch our own JS/HTML/CSS, so employees' agents pull a few
 * MB instead of redownloading Electron itself. See src/lib/updater.js.
 *
 * Output: dist/ItappiTrackingAgent-update-<version>.zip + a ready-to-publish
 * latest.json printed to stdout. Publishing means uploading BOTH to
 * /opt/tracking-timer/updates/ on the server — see docs/PUBLICAR-ACTUALIZACION.md.
 *
 * Only ships what package-win.mjs's win32-x64 build already contains, so an
 * update payload is only valid for agents installed from that build (an
 * Electron version bump, or a new native dependency, still needs a full
 * manual redistribution via npm run package:win).
 *
 * Run: npm run package:update
 */
import { mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAppResources } from "./lib/stage-app.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const stagingDir = join(distDir, "update-staging");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const zipOut = join(distDir, `ItappiTrackingAgent-update-${pkg.version}.zip`);

const log = (msg) => console.log(`  ${msg}`);

function python(code) {
  return execFileSync("python3", ["-c", code], { encoding: "utf8", maxBuffer: 1 << 28 });
}

log(`Empaquetando actualización v${pkg.version}…`);
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

const appResources = join(stagingDir, "app");
const { depCount } = await stageAppResources(root, appResources, "win32-x64");
log(`${depCount} paquete(s) de producción incluidos`);

await rm(zipOut, { force: true });
// Flat zip — paths relative to appResources itself, no wrapping folder, so
// extractZip() lands them directly under resources/app on the employee's
// machine. Unlike the full install zip, there is no OUT_NAME prefix here.
python(`
import os, zipfile
src = ${JSON.stringify(appResources)}
out = ${JSON.stringify(zipOut)}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for folder, _, files in os.walk(src):
        for f in files:
            full = os.path.join(folder, f)
            rel = os.path.relpath(full, src)
            z.write(full, rel)
`);

const sha256 = createHash("sha256").update(await readFile(zipOut)).digest("hex");
const zipSize = (await stat(zipOut)).size;

const manifest = {
  version: pkg.version,
  // Plain HTTP — this server has no TLS on the IP-based vhost (see
  // nginx's tracking-timer site, listen 80 only). Edit if that ever changes.
  url: `http://2.24.208.142/updates/${zipOut.split("/").pop()}`,
  sha256,
  notes: "",
};

console.log("");
console.log("  Listo.");
console.log(`    ZIP: ${zipOut}  (${(zipSize / 1024 / 1024).toFixed(2)} MB)`);
console.log("");
console.log("  Para publicar (en el servidor, /opt/tracking-timer/updates/):");
console.log(`    1. Sube ${zipOut.split("/").pop()} a esa carpeta.`);
console.log("    2. Sube latest.json con este contenido (edita \"notes\" si quieres):");
console.log("");
console.log(JSON.stringify(manifest, null, 2));
console.log("");
console.log("  Mientras latest.json no exista, ningún agente ve la actualización (204).");
console.log("  Publicarlo la propaga sola a todos los agentes con auto-updater silencioso.");
