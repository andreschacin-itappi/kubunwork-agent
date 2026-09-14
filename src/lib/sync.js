const { EventEmitter } = require("events");

const MAX_RECORDS_PER_BATCH = 500; // activityBatchSchema caps the array at 500

/**
 * Uploads queued buckets and the day's timer on an interval.
 *
 * The queue is the reason the agent survives a bad network: buckets accumulate
 * on disk and only leave the queue once the server has actually accepted them.
 */
class Syncer extends EventEmitter {
  constructor({ api, store, tracker, getConfig }) {
    super();
    this.api = api;
    this.store = store;
    this.tracker = tracker;
    this.getConfig = getConfig;

    this.timer = null;
    this.inFlight = false;
    this.lastSyncAt = null;
    this.lastError = null;
  }

  start() {
    this.stop();
    const seconds = Math.max(15, this.getConfig().syncIntervalSeconds || 90);
    this.timer = setInterval(() => {
      this.syncNow().catch(() => {
        /* syncNow already reports through events */
      });
    }, seconds * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Restart the interval after the server hands us a different cadence. */
  reschedule() {
    if (this.timer) this.start();
  }

  get pending() {
    return this.store.get("queue").length;
  }

  async syncNow() {
    if (this.inFlight) return;
    if (!this.api.token) return;

    this.inFlight = true;
    this.emit("status", this.#status("syncing"));

    try {
      this.store.pruneQueue(this.getConfig().offlineRetentionDays);

      const queue = this.store.get("queue");
      const batch = queue.slice(0, MAX_RECORDS_PER_BATCH);
      const snap = this.tracker.snapshot();

      const res = await this.api.postActivity({
        records: batch,
        trackedSeconds: snap.trackedSeconds,
      });

      // Accepted (201) or partially accepted (207). Either way these records
      // have had their turn — keeping them would retry the same rejection
      // forever and block every bucket behind them.
      this.store.get("queue").splice(0, batch.length);
      this.store.save({ immediate: true });

      if (res?.failed > 0) {
        this.emit("warning", `El servidor rechazó ${res.failed} de ${res.total} registros`);
      }

      // Bidirectional convergence: another session (or a previous install) may
      // have pushed a higher total for today. Take the larger value so the
      // employee never loses time by reinstalling the agent.
      if (typeof res?.serverTrackedSeconds === "number") {
        this.tracker.adoptTrackedSeconds(res.serverTrackedSeconds);
      }

      this.lastSyncAt = Date.now();
      this.lastError = null;
      this.emit("status", this.#status("ok"));
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        this.lastError = "Sesión expirada";
        this.emit("unauthorized");
        this.emit("status", this.#status("error"));
        return;
      }

      if (err.status === 400 || err.status === 422) {
        // Malformed batch: dropping it is the only way out of a poison-pill
        // loop that would otherwise stall the queue permanently.
        const dropped = this.store.get("queue").splice(0, MAX_RECORDS_PER_BATCH).length;
        this.store.save({ immediate: true });
        this.lastError = `Lote inválido descartado (${dropped} registros)`;
        this.emit("warning", this.lastError);
        this.emit("status", this.#status("error"));
        return;
      }

      // Network error or 5xx: keep the queue and try again next interval.
      this.lastError = err.message;
      this.emit("status", this.#status("error"));
    } finally {
      this.inFlight = false;
    }
  }

  #status(state) {
    return {
      state,
      pending: this.pending,
      lastSyncAt: this.lastSyncAt,
      error: this.lastError,
    };
  }
}

module.exports = { Syncer, MAX_RECORDS_PER_BATCH };
