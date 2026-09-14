/**
 * Logic tests for the agent's measurement and sync layers.
 *
 * The UI and the global input hook need a real desktop, but everything that
 * decides what number reaches the server is pure and testable here:
 * scoring, idle handling (never subtracts, only stops counting), bucket
 * shape, day rollover, queue draining.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { activityPct, activityPctFromSeconds } = require("../src/lib/metrics.js");
const { Tracker, localDateString } = require("../src/lib/tracker.js");
const { Syncer } = require("../src/lib/sync.js");
const { Store } = require("../src/lib/store.js");

const CONFIG = {
  idleThresholdMinutes: 5,
  syncIntervalSeconds: 90,
  bucketDurationSeconds: 60,
  offlineRetentionDays: 7,
  trackKeystrokes: true,
  trackMouseClicks: true,
  trackMouseMoves: true,
};

/**
 * Builds a Tracker whose clock and idle sensor are under test control.
 * The tick callback is captured by stubbing setInterval, so time advances
 * only when the test says so.
 */
function makeTracker({ config = CONFIG, startAt = Date.UTC(2026, 7, 7, 12, 0, 0) } = {}) {
  let now = startAt;
  let idle = 0;

  const realNow = Date.now;
  const realSetInterval = global.setInterval;
  Date.now = () => now;

  const tracker = new Tracker({
    powerMonitor: { getSystemIdleTime: () => idle },
    getConfig: () => config,
  });

  // The constructor seeds `day.date` via `localDateString()`'s default `new
  // Date()`, which reads the real wall clock (Date.now() above doesn't affect
  // a bare `new Date()`). Left uncorrected, that real "today" disagrees with
  // the mocked `now` used everywhere else and fires a bogus day-rollover on
  // the tracker's very first tick. Re-seed it from the mocked time instead.
  tracker.day = { date: localDateString(new Date(now)), trackedSeconds: 0 };

  const buckets = [];
  tracker.on("bucket", (record) => buckets.push(record));

  // The tracker registers its 1s interval inside start(), so the stub has to
  // be in place for that call and only that call — leaving it installed would
  // break the test runner's own timers.
  let tickFn = null;
  const capturingStart = () => {
    global.setInterval = (fn) => {
      tickFn = fn;
      // Must be truthy: the tracker's own `if (this.tickTimer) return;` guard
      // uses this to skip re-arming on a second start() (e.g. resume after a
      // manual pause). A falsy id like 0 would defeat that guard and — once
      // this stub is restored to the real setInterval right after — let a
      // resume leak an actual, never-cleared 1s interval into the process.
      return { fake: true };
    };
    try {
      tracker.start();
    } finally {
      global.setInterval = realSetInterval;
    }
  };

  return {
    tracker,
    buckets,
    start: capturingStart,
    setIdle: (seconds) => {
      idle = seconds;
    },
    /** Advance the clock one second per tick, driving the real tick handler. */
    advance(seconds) {
      for (let i = 0; i < seconds; i++) {
        now += 1000;
        if (tickFn) tickFn();
      }
    },
    setNow: (ms) => {
      now = ms;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

// --- scoring ---------------------------------------------------------------

test("activity score matches the backend's weighted formula", () => {
  // Baselines from backend/src/services/metrics.ts: 100 keys, 10 clicks,
  // 5000 px, weighted 50/25/25.
  assert.equal(activityPct({ keystrokes: 100, mouseClicks: 10, mouseDistance: 5000 }, 60), 100);
  assert.equal(activityPct({ keystrokes: 0, mouseClicks: 0, mouseDistance: 0 }, 60), 0);
  assert.equal(activityPct({ keystrokes: 50, mouseClicks: 5, mouseDistance: 2500 }, 60), 50);
  assert.equal(activityPct({ keystrokes: 100, mouseClicks: 0, mouseDistance: 0 }, 60), 50);
  assert.equal(activityPct({ keystrokes: 0, mouseClicks: 10, mouseDistance: 0 }, 60), 25);
});

test("score clamps at 100 no matter how far past the baselines", () => {
  assert.equal(activityPct({ keystrokes: 100000, mouseClicks: 9999, mouseDistance: 999999 }, 60), 100);
});

test("shorter buckets are normalised to a per-minute rate", () => {
  // 50 keys in 30s is the same work rate as 100 keys in 60s.
  assert.equal(activityPct({ keystrokes: 50, mouseClicks: 0, mouseDistance: 0 }, 30), 50);
});

test("fallback score is the share of the bucket that had input", () => {
  assert.equal(activityPctFromSeconds(30, 60), 50);
  assert.equal(activityPctFromSeconds(0, 60), 0);
  assert.equal(activityPctFromSeconds(60, 60), 100);
});

// --- timer and idle --------------------------------------------------------

test("timer counts one second per tick while the user is active", () => {
  const h = makeTracker();
  h.start();
  h.advance(120);
  assert.equal(h.tracker.snapshot().trackedSeconds, 120);
  h.restore();
});

test("crossing the idle threshold stops counting, but never subtracts what was already banked", () => {
  const h = makeTracker();
  h.start();

  h.advance(400); // 400s of activity
  assert.equal(h.tracker.snapshot().trackedSeconds, 400);

  h.setIdle(300); // exactly the 5-minute threshold
  h.advance(1);

  let snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, 400, "confirmed idle must not subtract the banked total");
  assert.equal(snap.isIdle, true);

  // Staying idle must not keep counting either.
  h.setIdle(600);
  h.advance(120);
  snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, 400, "no further time counted while idle");

  // Coming back resumes counting from exactly where it left off.
  h.setIdle(0);
  h.advance(10);
  assert.equal(h.tracker.snapshot().trackedSeconds, 410);
  h.restore();
});

test("a pause under the threshold is credited in full once activity resumes", () => {
  const h = makeTracker(); // 5-minute (300s) threshold
  h.start();
  h.advance(60); // 60s banked
  h.setIdle(200); // well under the 300s threshold — not yet resolved either way
  h.advance(50);

  let snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, 60, "the quiet stretch is held, not credited or lost, while unresolved");
  assert.equal(snap.isIdle, false, "under the threshold is not confirmed idle");

  // Activity resumes — the whole quiet stretch turns out to have been a
  // short pause, not real inactivity, so it is credited in full.
  h.setIdle(0);
  h.advance(1);
  snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, 111, "60 already banked + 50 held seconds + this one, never less");
  h.restore();
});

test("a paused timer records nothing", () => {
  const h = makeTracker();
  h.start();
  h.advance(30);
  h.tracker.stop();
  h.advance(120);
  assert.equal(h.tracker.snapshot().trackedSeconds, 30);
  h.restore();
});

test("the default idle threshold is 15 minutes when config omits it", () => {
  const h = makeTracker({ config: {} }); // no idleThresholdMinutes at all
  h.start();
  h.advance(400);

  // 5 minutes idle used to be enough to confirm idle under the old default;
  // it must not anymore now that the default threshold is 15 minutes.
  h.setIdle(300);
  h.advance(1);
  let snap = h.tracker.snapshot();
  assert.equal(snap.isIdle, false, "5 minutes idle must not confirm idle under the new 15-minute default");
  assert.equal(snap.trackedSeconds, 400, "still held, not yet committed nor lost");

  h.setIdle(900); // 15 minutes
  h.advance(1);
  snap = h.tracker.snapshot();
  assert.equal(snap.isIdle, true, "15 minutes idle does cross the new default threshold");
  assert.equal(snap.trackedSeconds, 400, "confirming idle still doesn't touch the banked total");
  h.restore();
});

test("an idle ramp-up that begins while still running is held, not eagerly counted — nothing is ever taken back", () => {
  // Regression coverage for the resume-after-pause bug from the employee's
  // point of view: whether the quiet stretch started before or after a
  // manual pause must not matter, because neither one is ever added to
  // trackedSeconds speculatively in the first place — see the sibling test
  // below for the "starts after the pause" half of this guarantee.
  const h = makeTracker(); // 5-minute (300s) threshold
  h.start();
  h.advance(60); // 60s of real, active work
  h.setIdle(299); // one second short of the threshold — still running
  h.advance(50); // the ramp-up continues while still "running"
  let snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, 60, "the ramp-up window was never eagerly counted, so there is nothing to claw back");

  h.tracker.stop(); // the employee pauses mid-ramp-up
  assert.equal(h.tracker.snapshot().trackedSeconds, 60, "pausing alone must not change anything");

  // Idle keeps climbing well past the threshold, now while paused.
  h.setIdle(900);
  h.advance(200);
  snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, 60, "confirmed idle simply stops counting — nothing was ever added to subtract");
  assert.equal(snap.isIdle, true);

  // The employee returns and resumes.
  h.setIdle(0);
  h.tracker.start();
  h.advance(5);
  assert.equal(h.tracker.snapshot().trackedSeconds, 65, "counting resumes cleanly from the untouched pre-idle total");
  h.restore();
});

test("a long manual pause (e.g. lunch) never subtracts already-banked time", () => {
  // Regression test for the lunch-pause bug: the employee was fully active
  // (idle=0) right up to clicking "Pausar" — the idle streak that later
  // crosses the threshold only starts *after* the pause, so nothing was ever
  // held against the pre-pause total and nothing should ever be lost, no
  // matter how long the pause lasts.
  const h = makeTracker(); // 5-minute (300s) threshold
  h.start();
  h.advance(500); // 500s of real, active work
  h.tracker.stop();
  const beforeLunch = h.tracker.snapshot().trackedSeconds;
  assert.equal(beforeLunch, 500);

  // Idle starts climbing only now, well after the pause, and blows way past
  // the threshold (a full lunch break) — even a power loss right here must
  // not cost anything, since trackedSeconds is never touched while paused.
  h.setIdle(1800); // 30 minutes idle, all of it while paused
  h.advance(200);

  const snap = h.tracker.snapshot();
  assert.equal(snap.trackedSeconds, beforeLunch, "the pre-pause total must stay intact, exactly");

  // Resuming continues from exactly where it left off.
  h.setIdle(0);
  h.tracker.start();
  h.advance(10);
  assert.equal(h.tracker.snapshot().trackedSeconds, beforeLunch + 10);
  h.restore();
});

// --- buckets ---------------------------------------------------------------

test("buckets close on aligned minute boundaries and satisfy the server schema", () => {
  const h = makeTracker({ startAt: Date.UTC(2026, 7, 7, 12, 0, 0) });
  h.start();
  h.advance(180); // three full minutes

  assert.ok(h.buckets.length >= 2, `expected buckets, got ${h.buckets.length}`);

  for (const record of h.buckets) {
    // Constraints from backend/src/schemas/activity.schema.ts
    assert.match(record.bucket_start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Number.isInteger(record.keystrokes) && record.keystrokes >= 0);
    assert.ok(Number.isInteger(record.mouse_clicks) && record.mouse_clicks >= 0);
    assert.ok(Number.isInteger(record.mouse_moves) && record.mouse_moves >= 0);
    assert.ok(Number.isInteger(record.mouse_distance) && record.mouse_distance >= 0);
    assert.ok(Number.isInteger(record.activity_pct));
    assert.ok(record.activity_pct >= 0 && record.activity_pct <= 100);
    assert.equal(typeof record.is_idle, "boolean");
    assert.ok(Number.isInteger(record.active_seconds));
    assert.ok(record.active_seconds >= 0 && record.active_seconds <= 60, "active_seconds must fit 0–60");
    assert.ok(["tap", "fallback"].includes(record.capture_mode));

    // Alignment is what makes the server's upsert idempotent.
    assert.equal(new Date(record.bucket_start).getTime() % 60000, 0);
  }
  h.restore();
});

test("a bucket with no input at all is flagged idle", () => {
  const h = makeTracker();
  h.start();
  h.setIdle(120); // input stopped, but below the 300s tracking threshold
  h.advance(130);

  const idleBuckets = h.buckets.filter((b) => b.is_idle);
  assert.ok(idleBuckets.length >= 1);
  assert.equal(idleBuckets[0].active_seconds, 0);
  assert.equal(idleBuckets[0].activity_pct, 0);
  h.restore();
});

test("any activity in a bucket credits the whole minute, not just the active seconds", () => {
  const h = makeTracker();
  h.start();

  // A single second of real input, then silence for the rest of the minute —
  // low, minimal activity that must still count as a full minute worked.
  h.setIdle(0);
  h.advance(1);
  h.setIdle(5);
  h.advance(59);

  assert.equal(h.buckets.length, 1);
  assert.equal(h.buckets[0].is_idle, false);
  assert.equal(h.buckets[0].active_seconds, 60, "one second of input still credits the full minute");
  h.restore();
});

test("active_seconds is capped at the schema maximum", () => {
  const h = makeTracker();
  h.start();
  h.advance(200); // idle stays 0, so every second is active
  for (const record of h.buckets) {
    assert.ok(record.active_seconds <= 60);
  }
  h.restore();
});

test("a long sleep does not emit a burst of empty buckets", () => {
  const h = makeTracker();
  h.start();
  h.advance(60);
  const afterFirst = h.buckets.length;

  // Simulate the machine waking three hours later.
  h.setNow(Date.UTC(2026, 7, 7, 15, 0, 0));
  h.advance(2);

  assert.ok(h.buckets.length - afterFirst <= 2, `emitted ${h.buckets.length - afterFirst} buckets for a 3h gap`);
  h.restore();
});

// --- day rollover ----------------------------------------------------------

test("local midnight resets the day counter", () => {
  // 23:59:50 local time, whatever this host's zone is.
  const base = new Date(2026, 7, 7, 23, 59, 50).getTime();
  const h = makeTracker({ startAt: base });
  h.start();
  h.advance(5);
  assert.ok(h.tracker.snapshot().trackedSeconds > 0);

  let rolled = null;
  h.tracker.on("day-rollover", (previous) => {
    rolled = previous;
  });

  h.advance(20); // crosses midnight

  assert.ok(rolled, "day-rollover should fire");
  assert.equal(h.tracker.snapshot().trackedSeconds <= 20, true);
  assert.notEqual(h.tracker.snapshot().date, rolled.date);
  h.restore();
});

test("restoring a stale day starts from zero", () => {
  const h = makeTracker();
  h.tracker.restoreDay({ date: "2020-01-01", trackedSeconds: 9999 });
  assert.equal(h.tracker.snapshot().trackedSeconds, 0);
  h.restore();
});

test("the server's higher total wins on convergence", () => {
  const h = makeTracker();
  h.start();
  h.advance(100);
  h.tracker.adoptTrackedSeconds(500);
  assert.equal(h.tracker.snapshot().trackedSeconds, 500);

  h.tracker.adoptTrackedSeconds(10); // a lower value must not roll us back
  assert.equal(h.tracker.snapshot().trackedSeconds, 500);
  h.restore();
});

// --- store -----------------------------------------------------------------

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
  return { dir, store: new Store(dir, null) };
}

test("state survives a round trip through disk", () => {
  const { dir, store } = makeStore();
  store.set("serverUrl", "https://tracking.example.com");
  store.enqueue({ bucket_start: new Date().toISOString(), keystrokes: 5 });
  store.save({ immediate: true });

  const reopened = new Store(dir, null);
  assert.equal(reopened.get("serverUrl"), "https://tracking.example.com");
  assert.equal(reopened.get("queue").length, 1);
});

test("a corrupt state file does not prevent startup", () => {
  const { dir } = makeStore();
  writeFileSync(join(dir, "agent-state.json"), "{ this is not json");
  const store = new Store(dir, null);
  assert.equal(store.get("queue").length, 0);
  assert.equal(store.get("serverUrl"), "");
});

test("queue pruning drops only records past the retention window", () => {
  const { store } = makeStore();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const recent = new Date(Date.now() - 3600000).toISOString();
  store.enqueue({ bucket_start: old });
  store.enqueue({ bucket_start: recent });

  const dropped = store.pruneQueue(7);
  assert.equal(dropped, 1);
  assert.equal(store.get("queue").length, 1);
  assert.equal(store.get("queue")[0].bucket_start, recent);
});

test("writes are atomic — no partial file is left behind", () => {
  const { dir, store } = makeStore();
  store.set("serverUrl", "https://a.example.com");
  store.save({ immediate: true });
  const content = readFileSync(join(dir, "agent-state.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(content));
});

// --- sync ------------------------------------------------------------------

function makeSyncer({ respond }) {
  const { store } = makeStore();
  const calls = [];
  const api = {
    token: "fake-token",
    postActivity: async (payload) => {
      calls.push(payload);
      return respond(payload, calls.length);
    },
  };
  const tracker = {
    snapshot: () => ({ trackedSeconds: 1234 }),
    adopted: null,
    adoptTrackedSeconds(value) {
      this.adopted = value;
    },
  };
  const syncer = new Syncer({ api, store, tracker, getConfig: () => CONFIG });
  return { syncer, store, calls, tracker };
}

function fillQueue(store, count) {
  for (let i = 0; i < count; i++) {
    store.enqueue({ bucket_start: new Date(Date.now() - i * 60000).toISOString(), keystrokes: i });
  }
}

test("a successful sync clears exactly the records it sent", async () => {
  const { syncer, store, calls } = makeSyncer({ respond: () => ({ inserted: 500, failed: 0, total: 500 }) });
  fillQueue(store, 600);

  await syncer.syncNow();

  assert.equal(calls[0].records.length, 500, "batches respect the 500-record schema cap");
  assert.equal(store.get("queue").length, 100, "the remainder stays queued");

  await syncer.syncNow();
  assert.equal(store.get("queue").length, 0);
});

test("the timer is sent even with an empty queue", async () => {
  const { syncer, calls } = makeSyncer({ respond: () => ({ inserted: 0, failed: 0, total: 0 }) });
  await syncer.syncNow();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].records.length, 0);
  assert.equal(calls[0].trackedSeconds, 1234);
  assert.equal(calls[0].idleSubtractedSeconds, undefined, "the idle-giveback field no longer exists");
});

test("the server's tracked total is adopted from the response", async () => {
  const { syncer, tracker } = makeSyncer({
    respond: () => ({ inserted: 0, failed: 0, total: 0, serverTrackedSeconds: 7200 }),
  });
  await syncer.syncNow();
  assert.equal(tracker.adopted, 7200);
});

test("a network failure keeps the queue for the next attempt", async () => {
  const { syncer, store } = makeSyncer({
    respond: () => {
      const err = new Error("Sin conexión con el servidor");
      err.status = 0;
      throw err;
    },
  });
  fillQueue(store, 10);

  await syncer.syncNow();

  assert.equal(store.get("queue").length, 10, "nothing may be lost on a network error");
  assert.equal(syncer.lastError, "Sin conexión con el servidor");
});

test("an expired token signals the app instead of dropping data", async () => {
  const { syncer, store } = makeSyncer({
    respond: () => {
      const err = new Error("Unauthorized");
      err.status = 401;
      throw err;
    },
  });
  fillQueue(store, 5);

  let unauthorized = false;
  syncer.on("unauthorized", () => {
    unauthorized = true;
  });

  await syncer.syncNow();

  assert.equal(unauthorized, true);
  assert.equal(store.get("queue").length, 5, "records survive a re-login");
});

test("a rejected batch is dropped so it cannot block the queue forever", async () => {
  const { syncer, store } = makeSyncer({
    respond: () => {
      const err = new Error("Validation failed");
      err.status = 400;
      throw err;
    },
  });
  fillQueue(store, 3);

  await syncer.syncNow();

  assert.equal(store.get("queue").length, 0, "a poison-pill batch must not stall every later bucket");
});

test("concurrent syncs do not double-send", async () => {
  let resolveFirst;
  const gate = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { syncer, store, calls } = makeSyncer({
    respond: async () => {
      await gate;
      return { inserted: 1, failed: 0, total: 1 };
    },
  });
  fillQueue(store, 1);

  const first = syncer.syncNow();
  const second = syncer.syncNow(); // must be a no-op while the first is in flight
  resolveFirst();
  await Promise.all([first, second]);

  assert.equal(calls.length, 1);
});
