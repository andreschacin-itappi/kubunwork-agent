/* Renderer. No Node access — everything goes through window.agent (preload.js). */

/**
 * Employee-facing "bucket" cycle: a repeating window (same length as the
 * server's idle threshold) that always ends one of two ways — confirmed as
 * sent, or frozen as paused because there was no activity.
 *
 * Windows are aligned to the wall clock (`floor(now / periodMs)`) instead of
 * counting from whenever tracking last started. That is what lets the web
 * dashboard (frontend/src/lib/bucketCycle.ts — same formula, reimplemented
 * in TS since it's a different repo/runtime) show the *same* countdown for
 * the same employee without the agent ever having to report its window
 * start: any two clocks agree on `floor(now / periodMs)` without exchanging
 * a single byte. The only thing that still has to come from the agent is
 * whether the window was idle — see the periodic ping in main.js
 * (X-Agent-Idle / X-Agent-Running headers) and agent-presence.ts.
 *
 * Pure and state-passed-in so it's testable from Node (see
 * test/bucket-cycle.test.mjs) despite living in a browser-only file. It sits
 * above every DOM access in this file on purpose — requiring this module
 * from Node must not touch `document`, which does not exist there.
 */
const BUCKET_FLASH_MS = 3000;

function bucketWindowIndex(now, periodMs) {
  return Math.floor(now / periodMs);
}

function bucketPeriodMs(state) {
  const minutes = state?.config?.idleThresholdMinutes || 15;
  return Math.max(1, minutes) * 60 * 1000;
}

function initialBucketState() {
  return { windowIndex: null, frozen: false, flashUntil: 0 };
}

/**
 * @param {{windowIndex: number|null, frozen: boolean, flashUntil: number}} bucketState
 * @param {{now: number, running: boolean, isIdle: boolean, periodMs: number}} input
 */
function nextBucketState(bucketState, { now, running, isIdle, periodMs }) {
  if (!running) {
    return { state: initialBucketState(), info: { mode: "stopped" } };
  }

  let { windowIndex, frozen, flashUntil } = bucketState;
  const currentIndex = bucketWindowIndex(now, periodMs);
  const windowStart = currentIndex * periodMs;

  if (windowIndex === null) {
    windowIndex = currentIndex;
  } else if (currentIndex !== windowIndex) {
    // One or more windows elapsed since the last render.
    if (frozen) {
      // Still frozen unless real activity has resumed — see below.
      if (!isIdle) {
        frozen = false;
        windowIndex = currentIndex;
      }
    } else if (isIdle) {
      frozen = true;
    } else {
      flashUntil = now + BUCKET_FLASH_MS;
      windowIndex = currentIndex;
    }
  }

  const state = { windowIndex, frozen, flashUntil };
  if (frozen) return { state, info: { mode: "paused" } };
  if (now < flashUntil) return { state, info: { mode: "sent" } };
  return { state, info: { mode: "counting", remainingMs: Math.max(0, windowStart + periodMs - now), periodMs } };
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { nextBucketState, initialBucketState, bucketWindowIndex, formatMMSS };
}

// --- everything below here needs a real DOM/window.agent -------------------

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);

  const el = {
    viewLogin: $("view-login"),
    viewMain: $("view-main"),
    loginForm: $("login-form"),
    server: $("server"),
    email: $("email"),
    password: $("password"),
    loginError: $("login-error"),
    loginSubmit: $("login-submit"),
    empName: $("emp-name"),
    empDept: $("emp-dept"),
    timer: $("timer"),
    statusLine: $("status-line"),
    toggle: $("toggle"),
    bucketRow: $("bucket-row"),
    bucketBar: $("bucket-bar"),
    bucketBarFill: $("bucket-bar-fill"),
    bucketTime: $("bucket-time"),
    infoOpen: $("info-open"),
    infoClose: $("info-close"),
    infoOverlay: $("info-overlay"),
    statActivity: $("stat-activity"),
    statKeys: $("stat-keys"),
    statClicks: $("stat-clicks"),
    syncState: $("sync-state"),
    syncPending: $("sync-pending"),
    captureMode: $("capture-mode"),
    autostart: $("autostart"),
    logout: $("logout"),
    serverLabel: $("server-label"),
  };

  let bucketState = initialBucketState();

  const updateBucket = (state) => {
    const { running, isIdle } = state.tracker;
    const result = nextBucketState(bucketState, {
      now: Date.now(),
      running,
      isIdle,
      periodMs: bucketPeriodMs(state),
    });
    bucketState = result.state;
    return result.info;
  };

  const formatHMS = (totalSeconds) => {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  const formatAgo = (timestamp) => {
    if (!timestamp) return "nunca";
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 10) return "ahora";
    if (seconds < 60) return `hace ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `hace ${minutes} min`;
    return `hace ${Math.floor(minutes / 60)} h`;
  };

  /**
   * Live score for the minute in progress, using the same weights as
   * src/lib/metrics.js. It is a preview only — the value actually stored is
   * the one the main process computes when the bucket closes.
   */
  const livePct = (counts) => {
    const kb = Math.min(1, counts.keystrokes / 100);
    const clicks = Math.min(1, counts.mouseClicks / 10);
    const move = Math.min(1, counts.mouseDistance / 5000);
    return Math.round(50 * kb + 25 * clicks + 25 * move);
  };

  const render = (state) => {
    if (!state) return;

    if (!state.authenticated) {
      el.viewLogin.hidden = false;
      el.viewMain.hidden = true;
      if (state.serverUrl && !el.server.value) el.server.value = state.serverUrl;
      return;
    }

    el.viewLogin.hidden = true;
    el.viewMain.hidden = false;

    const { tracker, sync, employee } = state;

    el.empName.textContent = employee?.name || "—";
    el.empDept.textContent = employee?.department || "—";
    el.serverLabel.textContent = state.serverUrl;

    el.timer.textContent = formatHMS(tracker.trackedSeconds);

    el.toggle.textContent = tracker.running ? "Pausar" : "Iniciar";
    el.toggle.classList.toggle("running", tracker.running);

    const bucketInfo = updateBucket(state);
    el.statusLine.className = "status";

    if (bucketInfo.mode === "stopped") {
      el.statusLine.textContent = "En pausa";
      el.bucketRow.hidden = true;
      el.bucketBar.hidden = true;
    } else if (bucketInfo.mode === "paused") {
      const idleMin = Math.floor(tracker.idleSeconds / 60);
      el.statusLine.textContent = `⏸ Bucket pausado hasta que te vuelvas a activar (sin actividad hace ${idleMin} min)`;
      el.statusLine.classList.add("paused");
      el.bucketRow.hidden = false;
      el.bucketBar.hidden = false;
      el.bucketTime.textContent = "en pausa";
      el.bucketBarFill.className = "bucket-bar-fill paused";
    } else if (bucketInfo.mode === "sent") {
      el.statusLine.textContent = "✓ Bucket enviado";
      el.statusLine.classList.add("sent");
      el.bucketRow.hidden = false;
      el.bucketBar.hidden = false;
      el.bucketTime.textContent = "enviado";
      el.bucketBarFill.className = "bucket-bar-fill sent";
    } else {
      el.statusLine.textContent = "Registrando actividad";
      el.statusLine.classList.add("active");
      el.bucketRow.hidden = false;
      el.bucketBar.hidden = false;
      el.bucketTime.textContent = formatMMSS(bucketInfo.remainingMs / 1000);
      el.bucketBarFill.className = "bucket-bar-fill";
      const pct = 100 - (bucketInfo.remainingMs / bucketInfo.periodMs) * 100;
      el.bucketBarFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    }

    const counts = tracker.current;
    el.statActivity.textContent =
      tracker.captureMode === "tap" ? `${livePct(counts)}%` : `${Math.round((counts.activeSeconds / 60) * 100)}%`;
    el.statKeys.textContent = counts.keystrokes;
    el.statClicks.textContent = counts.mouseClicks;

    el.syncState.className = "";
    if (sync.inFlight) {
      el.syncState.textContent = "enviando…";
    } else if (sync.error) {
      el.syncState.textContent = sync.error;
      el.syncState.classList.add("err");
    } else {
      el.syncState.textContent = formatAgo(sync.lastSyncAt);
      el.syncState.classList.add("ok");
    }

    el.syncPending.textContent = String(sync.pending);
    el.captureMode.textContent = tracker.captureMode === "tap" ? "completo" : "limitado (solo tiempo)";
    el.autostart.checked = Boolean(state.autoStart);
  };

  // --- events ----------------------------------------------------------------

  el.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    el.loginError.hidden = true;
    el.loginSubmit.disabled = true;
    el.loginSubmit.textContent = "Conectando…";

    const res = await window.agent.login({
      serverUrl: el.server.value.trim(),
      email: el.email.value.trim(),
      password: el.password.value,
    });

    el.loginSubmit.disabled = false;
    el.loginSubmit.textContent = "Iniciar sesión";

    if (!res.ok) {
      el.loginError.textContent = res.error;
      el.loginError.hidden = false;
      return;
    }
    el.password.value = "";
  });

  el.toggle.addEventListener("click", async () => {
    const state = await window.agent.getState();
    if (state.tracker.running) await window.agent.stop();
    else await window.agent.start();
    render(await window.agent.getState());
  });

  el.logout.addEventListener("click", async () => {
    el.logout.disabled = true;
    await window.agent.logout();
    el.logout.disabled = false;
    render(await window.agent.getState());
  });

  el.autostart.addEventListener("change", () => window.agent.setAutoStart(el.autostart.checked));

  const openInfo = () => {
    el.infoOverlay.hidden = false;
    el.infoClose.focus();
  };
  const closeInfo = () => {
    el.infoOverlay.hidden = true;
    el.infoOpen.focus();
  };
  el.infoOpen.addEventListener("click", openInfo);
  el.infoClose.addEventListener("click", closeInfo);
  el.infoOverlay.addEventListener("click", (event) => {
    if (event.target === el.infoOverlay) closeInfo();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.infoOverlay.hidden) closeInfo();
  });

  window.agent.onState(render);
  window.agent.getState().then(render);
}
