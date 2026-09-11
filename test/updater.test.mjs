/**
 * Logic tests for the silent auto-updater: version comparison, download +
 * checksum + extraction (updater.js, zip.js), and the file swap
 * (update-apply.js). The parts that are genuinely OS-specific — waiting for
 * the previous process to exit and relaunching (updater-helper.js) — are not
 * covered here because they need a real Windows install to mean anything;
 * everything that decides *whether* and *what* to apply is pure and tested.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { Updater, isNewer, parseVersion } = require("../src/lib/updater.js");
const { extractZip } = require("../src/lib/zip.js");
const { applyUpdate } = require("../src/lib/update-apply.js");

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "agent-updater-test-"));
}

// --- version comparison ------------------------------------------------

test("isNewer compares dotted versions numerically, not lexically", () => {
  assert.equal(isNewer("0.2.0", "0.1.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.0"), true); // lexical compare would get this backwards
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.2.0"), false);
  assert.equal(isNewer("1.0", "0.9.9"), true);
});

test("parseVersion treats malformed segments as 0 instead of throwing", () => {
  assert.deepEqual(parseVersion("1.x.3"), [1, 0, 3]);
  assert.deepEqual(parseVersion(""), [0]);
  assert.deepEqual(parseVersion(undefined), [0]);
});

// --- zip extraction ------------------------------------------------------

/** Builds a real zip the same way build/lib/stage-app.mjs does (Python's
 *  stdlib zipfile), so the reader is exercised against its actual producer
 *  rather than a hand-rolled fixture that might not match real archives. */
function buildFixtureZip(zipPath, files) {
  const src = tmpDir();
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(src, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("python3", [
    "-c",
    `
import os, zipfile
src = ${JSON.stringify(src)}
out = ${JSON.stringify(zipPath)}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for folder, _, files in os.walk(src):
        for f in files:
            full = os.path.join(folder, f)
            rel = os.path.relpath(full, src)
            z.write(full, rel)
`,
  ]);
}

test("extractZip reproduces a real zip's files and nested folders", () => {
  const dir = tmpDir();
  const zipPath = join(dir, "fixture.zip");
  buildFixtureZip(zipPath, {
    "package.json": '{"name":"demo"}',
    "src/main.js": "console.log('hi')\n",
    "ui/index.html": "<html></html>",
  });

  const destDir = join(dir, "out");
  extractZip(zipPath, destDir);

  assert.equal(readFileSync(join(destDir, "package.json"), "utf8"), '{"name":"demo"}');
  assert.equal(readFileSync(join(destDir, "src", "main.js"), "utf8"), "console.log('hi')\n");
  assert.equal(readFileSync(join(destDir, "ui", "index.html"), "utf8"), "<html></html>");
});

test("extractZip rejects an entry that tries to escape the destination", () => {
  const dir = tmpDir();
  const zipPath = join(dir, "evil.zip");
  const src = tmpDir();
  writeFileSync(join(src, "payload.txt"), "gotcha");
  execFileSync("python3", [
    "-c",
    `
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}, "w") as z:
    z.write(${JSON.stringify(join(src, "payload.txt"))}, "../../escaped.txt")
`,
  ]);

  assert.throws(() => extractZip(zipPath, join(dir, "out")), /fuera del destino/);
});

// --- applyUpdate (file swap) ----------------------------------------------

test("applyUpdate replaces appDir with stagedDir and cleans up", () => {
  const dir = tmpDir();
  const appDir = join(dir, "app");
  const stagedDir = join(dir, "staged");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(join(appDir, "main.js"), "old");
  writeFileSync(join(stagedDir, "main.js"), "new");

  applyUpdate(appDir, stagedDir);

  assert.equal(readFileSync(join(appDir, "main.js"), "utf8"), "new");
  assert.equal(existsSync(stagedDir), false);
  assert.equal(existsSync(`${appDir}.bak`), false);
});

test("applyUpdate rolls back to the previous app if the swap fails partway", () => {
  const dir = tmpDir();
  const appDir = join(dir, "app");
  // stagedDir deliberately missing — moveDir(stagedDir, appDir) inside
  // applyUpdate must fail, and appDir must still work afterwards.
  const stagedDir = join(dir, "does-not-exist");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "main.js"), "old");

  assert.throws(() => applyUpdate(appDir, stagedDir));

  assert.equal(readFileSync(join(appDir, "main.js"), "utf8"), "old");
  assert.equal(existsSync(`${appDir}.bak`), false);
});

// --- Updater (check + stage) ----------------------------------------------

function fakeFetch(responses) {
  let call = 0;
  return async (url) => {
    const entry = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (typeof entry === "function") return entry(url);
    return entry;
  };
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("check() returns null while nothing is published (204)", async () => {
  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.1.0",
    stagingDir: tmpDir(),
    fetchImpl: fakeFetch([{ status: 204, ok: false }]),
  });
  assert.equal(await updater.check(), null);
});

test("check() returns null when the published version is not newer", async () => {
  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.2.0",
    stagingDir: tmpDir(),
    fetchImpl: fakeFetch([jsonResponse(200, { version: "0.2.0", url: "https://x/app.zip", sha256: "abc" })]),
  });
  assert.equal(await updater.check(), null);
});

test("check() returns the manifest when a newer version is published", async () => {
  const manifest = { version: "0.3.0", url: "https://x/app.zip", sha256: "abc" };
  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.2.0",
    stagingDir: tmpDir(),
    fetchImpl: fakeFetch([jsonResponse(200, manifest)]),
  });
  assert.deepEqual(await updater.check(), manifest);
});

test("check() tolerates a network failure by returning null, not throwing", async () => {
  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.1.0",
    stagingDir: tmpDir(),
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.doesNotReject(async () => {
    assert.equal(await updater.check(), null);
  });
});

test("check() returns null with no server configured yet", async () => {
  const updater = new Updater({
    getBaseUrl: () => "",
    currentVersion: "0.1.0",
    stagingDir: tmpDir(),
    fetchImpl: fakeFetch([jsonResponse(200, { version: "9.9.9", url: "x", sha256: "y" })]),
  });
  assert.equal(await updater.check(), null);
});

test("stage() downloads, verifies the checksum and extracts the update", async () => {
  const dir = tmpDir();
  const zipPath = join(dir, "app.zip");
  buildFixtureZip(zipPath, { "package.json": '{"version":"0.3.0"}' });
  const zipBytes = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(zipBytes).digest("hex");

  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.2.0",
    stagingDir: join(dir, "staging"),
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => zipBytes }),
  });

  const staged = await updater.stage({ version: "0.3.0", url: "https://x/app.zip", sha256 });

  assert.equal(staged.version, "0.3.0");
  assert.equal(readFileSync(join(staged.appDir, "package.json"), "utf8"), '{"version":"0.3.0"}');
  assert.equal(updater.staged, staged);
});

test("stage() rejects a checksum mismatch and leaves nothing staged", async () => {
  const dir = tmpDir();
  const zipPath = join(dir, "app.zip");
  buildFixtureZip(zipPath, { "package.json": "{}" });
  const zipBytes = readFileSync(zipPath);

  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.2.0",
    stagingDir: join(dir, "staging"),
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => zipBytes }),
  });

  await assert.rejects(
    () => updater.stage({ version: "0.3.0", url: "https://x/app.zip", sha256: "0".repeat(64) }),
    /checksum/i
  );
  assert.equal(updater.staged, null);
  assert.equal(existsSync(join(dir, "staging", "0.3.0")), false);
});

test("stage() is idempotent for a version already staged — no second download", async () => {
  const dir = tmpDir();
  const zipPath = join(dir, "app.zip");
  buildFixtureZip(zipPath, { "package.json": "{}" });
  const zipBytes = readFileSync(zipPath);
  const sha256 = createHash("sha256").update(zipBytes).digest("hex");

  let downloads = 0;
  const updater = new Updater({
    getBaseUrl: () => "https://tracking.example.com",
    currentVersion: "0.2.0",
    stagingDir: join(dir, "staging"),
    fetchImpl: async () => {
      downloads += 1;
      return { ok: true, arrayBuffer: async () => zipBytes };
    },
  });

  const manifest = { version: "0.3.0", url: "https://x/app.zip", sha256 };
  const first = await updater.stage(manifest);
  const second = await updater.stage(manifest);

  assert.equal(downloads, 1);
  assert.equal(first, second);
});
