/**
 * Lays out `resources/app` — the part of the distribution that is actually
 * our code (src/ui/assets/package.json/node_modules). Shared by:
 *   - package-win.mjs / package-mac.mjs, which wrap it in a full Electron
 *     runtime for a fresh install.
 *   - package-update.mjs, which zips just this — the auto-updater downloads
 *     it and swaps it into an *existing* install without touching Electron
 *     itself (see src/lib/updater.js and update-apply.js).
 * Kept as one function so the two artifact types can never drift apart in
 * what "resources/app" contains for a given version.
 */
import { mkdir, rm, cp, readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";

async function exists(path) {
  try {
    await import("node:fs/promises").then((fs) => fs.stat(path));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} root - the agent package root (contains src/ui/assets/package.json).
 * @param {string} appResourcesDir - destination, e.g. .../resources/app.
 * @param {string} targetPlatformArch - uiohook-napi prebuild dir to keep, e.g. "win32-x64".
 */
export async function stageAppResources(root, appResourcesDir, targetPlatformArch) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  await rm(appResourcesDir, { recursive: true, force: true });
  await mkdir(appResourcesDir, { recursive: true });

  for (const entry of ["src", "ui", "assets"]) {
    await cp(join(root, entry), join(appResourcesDir, entry), { recursive: true });
  }

  // The shipped manifest keeps only what Electron reads at runtime. Build-time
  // tooling (resedit, electron itself) has no business inside the app.
  await writeFile(
    join(appResourcesDir, "package.json"),
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

  // Copy only production dependencies, resolved through npm rather than a
  // hand-kept list, so a new transitive dep can't be silently left behind.
  const listed = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(`${sep}node_modules${sep}`));

  if (listed.length === 0) throw new Error("npm ls no devolvió dependencias de producción");

  for (const modulePath of listed) {
    const relative = modulePath.slice(modulePath.indexOf(`${sep}node_modules${sep}`) + 1);
    await cp(modulePath, join(appResourcesDir, relative), { recursive: true });
  }

  const prebuilds = join(appResourcesDir, "node_modules", "uiohook-napi", "prebuilds");
  if (await exists(prebuilds)) {
    for (const platform of await readdir(prebuilds)) {
      if (platform !== targetPlatformArch) await rm(join(prebuilds, platform), { recursive: true, force: true });
    }
    if (!(await exists(join(prebuilds, targetPlatformArch)))) {
      throw new Error(`Falta el binario nativo ${targetPlatformArch} de uiohook-napi`);
    }
  }

  return { pkg, depCount: listed.length };
}
