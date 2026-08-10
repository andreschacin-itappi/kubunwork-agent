const { EventEmitter } = require("events");
const { activityPct, activityPctFromSeconds } = require("./metrics");

/**
 * Measurement engine.
 *
 * PRIVACY: this counts input events, it never records *which* keys are pressed,
 * what is typed, which windows are open, or anything about screen content. The
 * global hook exists purely to increment four integers per minute. Keep it that
 * way — the server schema (activity.schema.ts) has nowhere to put content, and
 * adding any would change what employees consented to when they logged in.
 *
 * Two capture modes, both reported to the server on every bucket:
 *   "tap"      — the global input hook is running, so real keystroke/click/
 *                travel counts feed the weighted score.
 *   "fallback" — the hook could not start (blocked by policy, missing perms).
 *                Counters stay 0 and the score degrades to the share of the
 *                minute that had any input at all, per the OS idle clock.
 */

const MAX_ACTIVE_SECONDS = 60; // activity.schema.ts caps active_seconds at 60

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emptyCounts() {
  return { keystrokes: 0, mouseClicks: 0, mouseMoves: 0, mouseDistance: 0, activeSeconds: 0 };
}

class Tracker extends EventEmitter {
  constructor({ powerMonitor, getConfig }) {
    super();
    this.powerMonitor = powerMonitor;
    this.getConfig = getConfig;

    this.running = false;
    this.captureMode = "fallback";
    this.hook = null;
    this.hookStarted = false;

    this.counts = emptyCounts();
    this.bucketStart = null;
    this.lastMouse = null;

    this.day = { date: localDateString(), trackedSeconds: 0, idleSubtracted: 0 };
    this.inIdle = false;
    this.idleSeconds = 0;

    this.tickTimer = null;
  }

  // --- lifecycle -----------------------------------------------------------

  /** Load state persisted from a previous run so a restart keeps the day's total. */
  restoreDay(day) {
    if (day && day.date === localDateString()) {
      this.day = {
        date: day.date,
        trackedSeconds: Math.max(0, day.trackedSeconds || 0),
        idleSubtracted: Math.max(0, day.idleSubtracted || 0),
      };
    } else {
      this.day = { date: localDateString(), trackedSeconds: 0, idleSubtracted: 0 };
    }
  }

  /**
   * Attach the global input hook. Failure here is expected on locked-down
   * machines and must not be fatal — we degrade to fallback mode and keep
   * measuring time, because a timer with no counters is still useful.
   */
  initCapture() {
    try {
      const { uIOhook, UiohookKey } = require("uiohook-napi");
      void UiohookKey;
      this.hook = uIOhook;

      this.hook.on("keydown", () => {
        if (!this.running) return;
        if (this.getConfig().trackKeystrokes) this.counts.keystrokes += 1;
      });

      this.hook.on("mousedown", () => {
        if (!this.running) return;
        if (this.getConfig().trackMouseClicks) this.counts.mouseClicks += 1;
      });

      this.hook.on("mousemove", (e) => {
        if (!this.running) return;
        if (!this.getConfig().trackMouseMoves) return;
        this.counts.mouseMoves += 1;
        if (this.lastMouse) {
          const dx = e.x - this.lastMouse.x;
          const dy = e.y - this.lastMouse.y;
          this.counts.mouseDistance += Math.sqrt(dx * dx + dy * dy);
        }
        this.lastMouse = { x: e.x, y: e.y };
      });

      this.hook.start();
      this.hookStarted = true;
      this.captureMode = "tap";
    } catch (err) {
      this.captureMode = "fallback";
      this.emit("capture-degraded", err.message);
    }
    return this.captureMode;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.bucketStart = this.#alignedBucketStart(Date.now());
    this.counts = emptyCounts();
    this.lastMouse = null;
    this.#ensureTicking();
    this.emit("state");
  }

  stop() {
    if (!this.running) return;
    // Flush whatever the partial minute holds; discarding it would silently
    // lose the work done since the last boundary.
    this.#flushBucket({ partial: true });
    this.running = false;
    this.inIdle = false;
    this.emit("state");
  }

  shutdown() {
    if (this.running) this.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.hookStarted) {
      try {
        this.hook.stop();
      } catch {
        /* the process is going away anyway */
      }
      this.hookStarted = false;
    }
  }

  // --- the clock -----------------------------------------------------------

  #ensureTicking() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.#tick(), 1000);
  }

  /** Bucket boundaries are absolute wall-clock slots, so two agents (or the
   *  same agent after a restart) produce the same bucket_start for the same
   *  minute — which is what makes the server's upsert idempotent. */
  #alignedBucketStart(nowMs) {
    const bucketMs = this.#bucketSeconds() * 1000;
    return Math.floor(nowMs / bucketMs) * bucketMs;
  }

  #bucketSeconds() {
    const configured = this.getConfig().bucketDurationSeconds || 60;
    // Never exceed 60: active_seconds is validated as 0–60 server-side.
    return Math.max(10, Math.min(60, configured));
  }

  #tick() {
    const now = Date.now();
    const today = localDateString(new Date(now));

    // Midnight in the employee's local zone starts a new tracked day. The
    // server keys daily_tracked_time by the employee's local date too, so the
    // counter has to reset here or yesterday's total would bleed into today.
    if (today !== this.day.date) {
      this.#flushBucket({ partial: true });
      const previous = { ...this.day };
      this.day = { date: today, trackedSeconds: 0, idleSubtracted: 0 };
      this.emit("day-rollover", previous);
    }

    this.idleSeconds = this.#systemIdleSeconds();
    const idleThreshold = Math.max(60, (this.getConfig().idleThresholdMinutes || 5) * 60);

    if (this.running) {
      if (this.idleSeconds >= idleThreshold) {
        if (!this.inIdle) {
          // The threshold window was counted as worked before we knew it was
          // idle. Give it back once, on entry, and let the server lower its
          // stored total by the same amount via idle_subtracted_seconds.
          this.inIdle = true;
          const giveBack = Math.min(this.day.trackedSeconds, idleThreshold);
          this.day.trackedSeconds -= giveBack;
          this.day.idleSubtracted += giveBack;
          this.emit("idle-entered", giveBack);
        }
      } else {
        if (this.inIdle) {
          this.inIdle = false;
          this.emit("idle-left");
        }
        this.day.trackedSeconds += 1;
      }

      // A second with input anywhere on the machine counts as active. This is
      // the OS idle clock, so it holds in fallback mode too.
      if (this.idleSeconds === 0 && this.counts.activeSeconds < MAX_ACTIVE_SECONDS) {
        this.counts.activeSeconds += 1;
      }

      if (now >= this.bucketStart + this.#bucketSeconds() * 1000) {
        this.#flushBucket({ partial: false });
      }
    }

    this.emit("tick", this.snapshot());
  }

  #systemIdleSeconds() {
    try {
      return this.powerMonitor.getSystemIdleTime();
    } catch {
      // Unsupported platform build: assume active rather than silently
      // freezing the timer for the whole session.
      return 0;
    }
  }

  // --- buckets -------------------------------------------------------------

  #flushBucket({ partial }) {
    if (this.bucketStart == null || !this.running) return;

    const bucketSeconds = this.#bucketSeconds();
    const counts = this.counts;
    const hadInput =
      counts.activeSeconds > 0 || counts.keystrokes > 0 || counts.mouseClicks > 0 || counts.mouseMoves > 0;

    const pct =
      this.captureMode === "tap"
        ? activityPct(counts, bucketSeconds)
        : activityPctFromSeconds(counts.activeSeconds, bucketSeconds);

    const record = {
      bucket_start: new Date(this.bucketStart).toISOString(),
      keystrokes: counts.keystrokes,
      mouse_clicks: counts.mouseClicks,
      mouse_moves: counts.mouseMoves,
      mouse_distance: Math.round(counts.mouseDistance),
      activity_pct: pct,
      is_idle: !hadInput,
      active_seconds: Math.min(MAX_ACTIVE_SECONDS, counts.activeSeconds),
      capture_mode: this.captureMode,
    };

    this.emit("bucket", record);

    this.counts = emptyCounts();
    this.bucketStart = partial ? this.#alignedBucketStart(Date.now()) : this.bucketStart + bucketSeconds * 1000;

    // A suspended laptop can leave the boundary far in the past; skip forward
    // instead of emitting a burst of empty buckets for the sleep window.
    const nowAligned = this.#alignedBucketStart(Date.now());
    if (this.bucketStart < nowAligned) this.bucketStart = nowAligned;
  }

  /** Let the sync layer reconcile with the server's stored total. */
  adoptTrackedSeconds(seconds) {
    if (typeof seconds !== "number" || seconds < 0) return;
    if (seconds > this.day.trackedSeconds) this.day.trackedSeconds = Math.floor(seconds);
  }

  snapshot() {
    return {
      running: this.running,
      captureMode: this.captureMode,
      trackedSeconds: this.day.trackedSeconds,
      idleSubtracted: this.day.idleSubtracted,
      date: this.day.date,
      isIdle: this.inIdle,
      idleSeconds: this.idleSeconds,
      current: { ...this.counts },
    };
  }
}

module.exports = { Tracker, localDateString };
