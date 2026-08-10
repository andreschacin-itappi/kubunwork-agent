/* Renderer. No Node access — everything goes through window.agent (preload.js). */

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
  statActivity: $("stat-activity"),
  statKeys: $("stat-keys"),
  statClicks: $("stat-clicks"),
  syncState: $("sync-state"),
  syncPending: $("sync-pending"),
  captureMode: $("capture-mode"),
  autostart: $("autostart"),
  sync: $("sync"),
  minimize: $("minimize"),
  logout: $("logout"),
  serverLabel: $("server-label"),
};

function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

function formatAgo(timestamp) {
  if (!timestamp) return "nunca";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "ahora";
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h`;
}

/**
 * Live score for the minute in progress, using the same weights as
 * src/lib/metrics.js. It is a preview only — the value actually stored is the
 * one the main process computes when the bucket closes.
 */
function livePct(counts) {
  const kb = Math.min(1, counts.keystrokes / 100);
  const clicks = Math.min(1, counts.mouseClicks / 10);
  const move = Math.min(1, counts.mouseDistance / 5000);
  return Math.round(50 * kb + 25 * clicks + 25 * move);
}

function render(state) {
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

  el.statusLine.className = "status";
  if (!tracker.running) {
    el.statusLine.textContent = "En pausa";
  } else if (tracker.isIdle) {
    el.statusLine.textContent = `Inactivo (${Math.floor(tracker.idleSeconds / 60)} min sin actividad)`;
    el.statusLine.classList.add("idle");
  } else {
    el.statusLine.textContent = "Registrando actividad";
    el.statusLine.classList.add("active");
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
  el.captureMode.textContent =
    tracker.captureMode === "tap" ? "completo" : "limitado (solo tiempo)";
  el.autostart.checked = Boolean(state.autoStart);
}

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

el.sync.addEventListener("click", async () => {
  el.sync.disabled = true;
  await window.agent.syncNow();
  el.sync.disabled = false;
  render(await window.agent.getState());
});

el.minimize.addEventListener("click", () => window.agent.hide());

el.logout.addEventListener("click", async () => {
  el.logout.disabled = true;
  await window.agent.logout();
  el.logout.disabled = false;
  render(await window.agent.getState());
});

el.autostart.addEventListener("change", () => window.agent.setAutoStart(el.autostart.checked));

window.agent.onState(render);
window.agent.getState().then(render);
