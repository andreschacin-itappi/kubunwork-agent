const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { extractZip } = require("./zip");

/**
 * Silent auto-update, agreed with the client to have NO employee-facing
 * prompt ("¿quieres actualizar?") — see HISTORIAL-CLAUDE.md 2026-08-10. The
 * server side (`/opt/tracking-timer/updates/`, served by nginx) already
 * existed; this is the client half: check a manifest, download and verify
 * the update, extract it. Actually swapping it into the running install is a
 * separate concern (see update-apply.js + updater-helper.js) because it can
 * only happen once the app has fully quit.
 *
 * The manifest lives at `${serverUrl}/updates/latest.json`. While it does
 * not exist, nginx answers 204 ("no update published") and every agent stays
 * silent — see the `location /updates/` block.
 */

/** "1.2.3" -> [1,2,3]. Non-numeric segments become 0 rather than throwing, so
 *  a malformed version string just sorts as very old instead of crashing. */
function parseVersion(v) {
  return String(v || "0")
    .trim()
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

class Updater extends EventEmitter {
  /**
   * @param {() => string} getBaseUrl - the agent's configured server URL.
   * @param {string} currentVersion - app.getVersion().
   * @param {string} stagingDir - where downloads get extracted (userData).
   * @param {typeof fetch} [fetchImpl]
   */
  constructor({ getBaseUrl, currentVersion, stagingDir, fetchImpl = fetch }) {
    super();
    this.getBaseUrl = getBaseUrl;
    this.currentVersion = currentVersion;
    this.stagingDir = stagingDir;
    this.fetchImpl = fetchImpl;
    /** @type {{version: string, appDir: string} | null} */
    this.staged = null;
  }

  /** Returns the manifest if a newer version is published, else null. Never
   *  throws — a bad network or a malformed manifest just means "no update
   *  right now", same as if nothing were published. */
  async check() {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) return null;

    let res;
    try {
      res = await this.fetchImpl(`${baseUrl}/updates/latest.json`, {
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return null;
    }
    if (res.status === 204 || res.status === 404 || !res.ok) return null;

    let manifest;
    try {
      manifest = await res.json();
    } catch {
      return null;
    }

    if (!manifest?.version || !manifest?.url || !manifest?.sha256) return null;
    if (!isNewer(manifest.version, this.currentVersion)) return null;
    return manifest;
  }

  /** Downloads, verifies and extracts `manifest`. Idempotent per version —
   *  calling it again for the same version reuses what is already staged. */
  async stage(manifest) {
    if (this.staged?.version === manifest.version) return this.staged;

    const versionDir = path.join(this.stagingDir, manifest.version);
    fs.rmSync(versionDir, { recursive: true, force: true });
    fs.mkdirSync(versionDir, { recursive: true });

    const zipPath = path.join(versionDir, "update.zip");
    try {
      await this.#download(manifest.url, zipPath);

      const actual = this.#sha256(zipPath);
      const expected = String(manifest.sha256).toLowerCase();
      if (actual !== expected) {
        throw new Error(`Checksum inválido (esperado ${expected.slice(0, 12)}…, obtenido ${actual.slice(0, 12)}…)`);
      }

      const appDir = path.join(versionDir, "app");
      extractZip(zipPath, appDir);
      fs.rmSync(zipPath, { force: true });

      this.staged = { version: manifest.version, appDir };
      this.emit("staged", this.staged);
      return this.staged;
    } catch (err) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      throw err;
    }
  }

  async #download(url, dest) {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`Descarga de la actualización falló (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
  }

  #sha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }
}

module.exports = { Updater, isNewer, parseVersion };
