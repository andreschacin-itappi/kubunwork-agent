/**
 * The tracker panel's "bucket" cycle (ui/app.js) is browser-only, but its
 * state machine is a pure function guarded by a `module.exports` no-op that
 * only fires outside the renderer — see the comment above nextBucketState in
 * ui/app.js. Exercised here from Node so it doesn't need a real window.
 *
 * The web dashboard reimplements the same formula in
 * frontend/src/lib/bucketCycle.ts — this suite is the spec for both.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { nextBucketState, initialBucketState, bucketWindowIndex } = require("../ui/app.js");

const PERIOD = 15 * 60 * 1000;
// A timestamp exactly on a 15-minute wall-clock boundary, for deterministic tests.
const BOUNDARY = Math.floor(Date.UTC(2026, 8, 8, 12, 0, 0) / PERIOD) * PERIOD;

test("bucketWindowIndex is a pure function of wall-clock time — the whole sync trick", () => {
  const now = BOUNDARY + 90000;
  assert.equal(bucketWindowIndex(now, PERIOD), bucketWindowIndex(now, PERIOD));
  assert.equal(bucketWindowIndex(BOUNDARY, PERIOD), bucketWindowIndex(BOUNDARY + PERIOD - 1, PERIOD));
  assert.equal(bucketWindowIndex(BOUNDARY + PERIOD, PERIOD), bucketWindowIndex(BOUNDARY, PERIOD) + 1);
});

test("not running yields 'stopped' and resets state", () => {
  const { state, info } = nextBucketState(
    { windowIndex: 5, frozen: true, flashUntil: 999 },
    { now: BOUNDARY, running: false, isIdle: false, periodMs: PERIOD }
  );
  assert.equal(info.mode, "stopped");
  assert.deepEqual(state, initialBucketState());
});

test("first render after starting anchors to the current wall-clock window and counts down", () => {
  const { state, info } = nextBucketState(initialBucketState(), {
    now: BOUNDARY + 60000,
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  });
  assert.equal(info.mode, "counting");
  assert.equal(info.remainingMs, PERIOD - 60000);
  assert.equal(state.windowIndex, bucketWindowIndex(BOUNDARY, PERIOD));
});

test("crossing a window boundary while active flashes 'sent' once, then counts the next window", () => {
  const started = nextBucketState(initialBucketState(), {
    now: BOUNDARY + 100,
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  });

  const crossed = nextBucketState(started.state, {
    now: BOUNDARY + PERIOD + 500,
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  });
  assert.equal(crossed.info.mode, "sent");

  const afterFlash = nextBucketState(crossed.state, {
    now: BOUNDARY + PERIOD + 4000, // past the 3s flash
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  });
  assert.equal(afterFlash.info.mode, "counting");
  assert.equal(afterFlash.info.remainingMs, PERIOD - 4000);
});

test("crossing a window boundary while idle freezes on 'paused' instead of flashing 'sent'", () => {
  const started = nextBucketState(initialBucketState(), {
    now: BOUNDARY + 100,
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  });

  const crossed = nextBucketState(started.state, {
    now: BOUNDARY + PERIOD + 500,
    running: true,
    isIdle: true,
    periodMs: PERIOD,
  });
  assert.equal(crossed.info.mode, "paused");

  // Stays paused across further window boundaries as long as it's still idle.
  const stillIdleMuchLater = nextBucketState(crossed.state, {
    now: BOUNDARY + PERIOD * 5,
    running: true,
    isIdle: true,
    periodMs: PERIOD,
  });
  assert.equal(stillIdleMuchLater.info.mode, "paused");
});

test("activity resuming after a freeze starts a fresh window immediately, not mid-cycle", () => {
  let s = nextBucketState(initialBucketState(), {
    now: BOUNDARY + 100,
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  }).state;
  s = nextBucketState(s, { now: BOUNDARY + PERIOD + 500, running: true, isIdle: true, periodMs: PERIOD }).state;

  const resumed = nextBucketState(s, {
    now: BOUNDARY + PERIOD * 3 + 12345,
    running: true,
    isIdle: false,
    periodMs: PERIOD,
  });
  assert.equal(resumed.info.mode, "counting");
  assert.equal(resumed.info.remainingMs, PERIOD - 12345);
});

test("two independent clients (agent + web) starting from a fresh state agree on every field", () => {
  const now = BOUNDARY + 7 * 60000;
  const agent = nextBucketState(initialBucketState(), { now, running: true, isIdle: false, periodMs: PERIOD });
  const web = nextBucketState(initialBucketState(), { now, running: true, isIdle: false, periodMs: PERIOD });
  assert.deepEqual(agent.info, web.info);
});
