/**
 * Activity scoring — MUST stay identical to the server's single source of
 * truth: backend/src/services/metrics.ts. If a baseline or weight changes
 * there, change it here too, otherwise the percentage the agent stores on each
 * bucket will drift from what the dashboard recomputes for the activity log.
 */

// Weighted scoring baselines (per minute).
const KB_BASELINE = 100; // keystrokes/min for a full keyboard score
const CLICK_BASELINE = 10; // clicks/min for a full click score
const DIST_BASELINE = 5000; // px of mouse travel/min for a full move score

// Component weights for the 0–100 activity score.
const WEIGHT_KEYBOARD = 50;
const WEIGHT_CLICKS = 25;
const WEIGHT_MOVEMENT = 25;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Score a single bucket from its raw counters.
 *
 * The baselines are per-minute, so counters from a bucket of a different
 * length are normalised to a minute first — otherwise a 30s bucket would
 * always score about half of what the same work rate scores in a 60s one.
 */
function activityPct(counts, bucketSeconds = 60) {
  const perMinute = bucketSeconds > 0 ? 60 / bucketSeconds : 1;
  const kb = clamp01((counts.keystrokes * perMinute) / KB_BASELINE);
  const clicks = clamp01((counts.mouseClicks * perMinute) / CLICK_BASELINE);
  const movement = clamp01((counts.mouseDistance * perMinute) / DIST_BASELINE);

  const score = WEIGHT_KEYBOARD * kb + WEIGHT_CLICKS * clicks + WEIGHT_MOVEMENT * movement;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Score for the degraded path, where no per-event counters exist because the
 * global input hook could not start. All we know is how many seconds of the
 * bucket had input at all, so the score is that ratio — flagged upstream with
 * capture_mode "fallback" so reports can tell the two apart.
 */
function activityPctFromSeconds(activeSeconds, bucketSeconds = 60) {
  if (bucketSeconds <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((activeSeconds / bucketSeconds) * 100)));
}

module.exports = {
  KB_BASELINE,
  CLICK_BASELINE,
  DIST_BASELINE,
  WEIGHT_KEYBOARD,
  WEIGHT_CLICKS,
  WEIGHT_MOVEMENT,
  activityPct,
  activityPctFromSeconds,
};
