const fs = require("fs");
const path = require("path");

/**
 * Durable agent state: credentials, the current day's counters and the queue of
 * buckets not yet accepted by the server.
 *
 * Everything lives in one JSON file under userData. Writes go through a temp
 * file + rename so a crash mid-write (or a machine losing power, which is
 * routine on employee laptops) can never leave a truncated file that would
 * lose an entire day of offline buckets.
 */
class Store {
  constructor(userDataPath, safeStorage) {
    this.file = path.join(userDataPath, "agent-state.json");
    this.safeStorage = safeStorage;
    this.data = this.#load();
    this.saveTimer = null;
  }

  #defaults() {
    return {
      serverUrl: "",
      token: null, // plaintext fallback, only when OS encryption is unavailable
      tokenEnc: null, // base64 of safeStorage-encrypted token (preferred)
      employee: null, // { id, name, department }
      day: null, // { date, trackedSeconds, idleSubtracted }
      queue: [], // activity records pending upload
      timerRunning: false,
      autoStart: false,
      config: null, // last known server config, so a cold offline start still works
    };
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      return { ...this.#defaults(), ...JSON.parse(raw) };
    } catch {
      // Missing or corrupt file: start clean rather than crash on launch.
      return this.#defaults();
    }
  }

  /** Coalesce bursts of writes (the tracker touches state every second). */
  save({ immediate = false } = {}) {
    if (immediate) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.#write();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.#write();
    }, 2000);
  }

  #write() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[store] write failed:", err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  // --- token ---------------------------------------------------------------
  // Prefer the OS keychain/DPAPI via safeStorage. It is not available on every
  // machine (e.g. a Linux box with no keyring), so fall back to plaintext
  // rather than locking the employee out of the agent entirely.

  setToken(token) {
    if (token && this.safeStorage?.isEncryptionAvailable()) {
      this.data.tokenEnc = this.safeStorage.encryptString(token).toString("base64");
      this.data.token = null;
    } else {
      this.data.token = token;
      this.data.tokenEnc = null;
    }
    this.save({ immediate: true });
  }

  getToken() {
    if (this.data.tokenEnc && this.safeStorage?.isEncryptionAvailable()) {
      try {
        return this.safeStorage.decryptString(Buffer.from(this.data.tokenEnc, "base64"));
      } catch {
        // Encrypted with a different OS user/profile — treat as logged out.
        return null;
      }
    }
    return this.data.token;
  }

  clearAuth() {
    this.data.token = null;
    this.data.tokenEnc = null;
    this.data.employee = null;
    this.save({ immediate: true });
  }

  // --- queue ---------------------------------------------------------------

  enqueue(record) {
    this.data.queue.push(record);
    this.save();
  }

  /**
   * Drop records the server would no longer want. `offline_retention_days`
   * comes from the server config; anything older is abandoned so a laptop that
   * spent a month offline does not push a backlog nobody will read.
   */
  pruneQueue(retentionDays) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 86400000;
    const before = this.data.queue.length;
    this.data.queue = this.data.queue.filter((r) => new Date(r.bucket_start).getTime() >= cutoff);
    const dropped = before - this.data.queue.length;
    if (dropped > 0) this.save();
    return dropped;
  }
}

module.exports = { Store };
