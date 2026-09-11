const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerMonitor, safeStorage, shell } = require("electron");

const { Store } = require("./lib/store");
const { Api, ApiError } = require("./lib/api");
const { Tracker } = require("./lib/tracker");
const { Syncer } = require("./lib/sync");
const { Updater } = require("./lib/updater");

// No dialog, no employee-facing prompt — silent by design (see
// HISTORIAL-CLAUDE.md 2026-08-10). A staged update only gets applied once the
// tracker is idle or stopped, so it never interrupts an active minute.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_FIRST_CHECK_DELAY_MS = 30 * 1000;

// Keeps the server's view of "app open / paused / idle" fresh — see
// agent-presence.ts. Runs unconditionally (not just for packaged builds).
const PING_INTERVAL_MS = 30 * 1000;

/** Mirrors the server's fallback block in config.routes.ts, so a first run with
 *  no network still measures with the same parameters the server would send. */
const DEFAULT_CONFIG = {
  idleThresholdMinutes: 15,
  syncIntervalSeconds: 90,
  bucketDurationSeconds: 60,
  offlineRetentionDays: 7,
  trackKeystrokes: true,
  trackMouseClicks: true,
  trackMouseMoves: true,
};

let store;
let api;
let tracker;
let syncer;
let updater;
let updateApplyInFlight = false;
let win = null;
let tray = null;
let config = { ...DEFAULT_CONFIG };
let quitting = false;
let ticksSinceSave = 0;

const startedHidden = process.argv.includes("--hidden");

// A second instance would run a second global hook and double-count every
// keystroke, so the first instance wins and simply reveals its window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(bootstrap);
}

function iconPath() {
  return path.join(__dirname, "..", "assets", "icon.png");
}

async function bootstrap() {
  store = new Store(app.getPath("userData"), safeStorage);
  api = new Api();
  api.configure({ baseUrl: store.get("serverUrl"), token: store.getToken(), version: app.getVersion() });

  if (store.get("config")) config = { ...DEFAULT_CONFIG, ...store.get("config") };

  tracker = new Tracker({ powerMonitor, getConfig: () => config });
  tracker.restoreDay(store.get("day"));
  tracker.initCapture();

  syncer = new Syncer({ api, store, tracker, getConfig: () => config });

  updater = new Updater({
    getBaseUrl: () => api.baseUrl,
    currentVersion: app.getVersion(),
    stagingDir: path.join(app.getPath("userData"), "update-staging"),
  });

  wireEvents();
  createWindow();
  createTray();

  if (api.token) {
    // Deliberately does NOT auto-resume tracking (even if it was running
    // before the app closed) — the employee decided that "Iniciar" should be
    // an explicit, physical click every time the agent starts, whatever the
    // reason (Windows boot, a manual relaunch, an auto-update). Syncing still
    // resumes on its own so any queued buckets from before still go out.
    refreshConfig();
    syncer.start();
    pingServer();
  }
  setInterval(pingServer, PING_INTERVAL_MS);

  if (app.isPackaged) {
    setTimeout(() => checkForAgentUpdate(), UPDATE_FIRST_CHECK_DELAY_MS);
    setInterval(() => checkForAgentUpdate(), UPDATE_CHECK_INTERVAL_MS);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

/** Best-effort — a missed ping just means the server treats this employee as
 *  offline for up to ~PAUSE/OFFLINE thresholds longer than reality. */
function pingServer() {
  if (!api.token) return;
  api.me({ isIdle: tracker.isIdle, running: tracker.running }).catch(() => {});
}

/** Silent — a failed check/download just gets retried on the next interval,
 *  same resilience posture as the activity syncer. */
async function checkForAgentUpdate() {
  try {
    const manifest = await updater.check();
    if (!manifest) return;
    await updater.stage(manifest);
    console.log(`[updater] versión ${manifest.version} descargada y verificada, esperando un momento sin actividad`);
  } catch (err) {
    console.warn("[updater] chequeo o descarga falló:", err.message);
  }
}

/** Only called once a staged update exists and the tracker is idle/stopped
 *  (see the "tick" handler in wireEvents). Hands off the actual file swap to
 *  a detached helper — see updater-helper.js for why it can't happen here. */
function applyStagedUpdateAndRestart() {
  if (!updater.staged || updateApplyInFlight) return;
  updateApplyInFlight = true;

  const appDir = path.join(process.resourcesPath, "app");
  const helperPath = path.join(__dirname, "updater-helper.js");

  spawn(process.execPath, [helperPath, String(process.pid), appDir, updater.staged.appDir, process.execPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
  }).unref();

  // Tracking never auto-resumes after any relaunch (see bootstrap) — quitApp()
  // already flushes and quits cleanly, so the update just reuses it.
  quitApp();
}

function wireEvents() {
  tracker.on("bucket", (record) => {
    store.enqueue(record);
    store.data.day = { ...tracker.day };
    store.save();
    pushState();
  });

  tracker.on("tick", () => {
    store.data.day = { ...tracker.day };
    // The day counter changes every second; persist it periodically instead of
    // rewriting the state file on every tick.
    if (++ticksSinceSave >= 30) {
      ticksSinceSave = 0;
      store.save();
    }
    pushState();

    // A staged update waits for a moment with nothing to interrupt: either
    // the tracker is idle, or the employee isn't tracking at all right now.
    if (app.isPackaged && updater?.staged && !updateApplyInFlight && (!tracker.running || tracker.isIdle)) {
      applyStagedUpdateAndRestart();
    }
  });

  tracker.on("state", () => {
    store.set("timerRunning", tracker.running);
    pushState();
    updateTray();
  });

  tracker.on("day-rollover", () => {
    // Push the finished day immediately; after midnight the server keys new
    // writes to the new date and the old total can no longer be corrected.
    syncer.syncNow().catch(() => {});
  });

  tracker.on("capture-degraded", (message) => {
    console.warn("[tracker] input hook unavailable:", message);
  });

  syncer.on("status", () => {
    pushState();
    updateTray();
  });

  syncer.on("unauthorized", () => {
    store.clearAuth();
    api.configure({ token: null });
    tracker.stop();
    syncer.stop();
    pushState();
    showWindow();
  });

  syncer.on("warning", (message) => console.warn("[sync]", message));

  // Sleep/resume: the OS idle clock jumps, and a bucket boundary may be hours
  // in the past. Flushing on suspend keeps the pre-sleep minute honest.
  // Waking back up does NOT restart tracking on its own — same "Iniciar" has
  // to be an explicit click every time, whether that's after a reboot, an
  // update, or the laptop coming back from sleep.
  powerMonitor.on("suspend", () => {
    tracker.stop();
    syncer.syncNow().catch(() => {});
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 740,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0f1117",
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));

  win.once("ready-to-show", () => {
    if (!startedHidden) win.show();
    pushState();
  });

  // Closing the window must not stop tracking — it hides to the tray, which is
  // also why the tray menu is the only place that really quits.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // Any external link opens in the real browser, never inside the agent.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip("Itappi Tracking Agent");
  tray.on("click", () => showWindow());
  updateTray();
}

function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

function updateTray() {
  if (!tray) return;
  const snap = tracker.snapshot();
  const authed = Boolean(api.token);

  const menu = Menu.buildFromTemplate([
    { label: authed ? `Hoy: ${formatHMS(snap.trackedSeconds)}` : "Sin sesión", enabled: false },
    { type: "separator" },
    { label: "Abrir", click: () => showWindow() },
    {
      label: snap.running ? "Pausar" : "Iniciar",
      enabled: authed,
      click: () => (snap.running ? tracker.stop() : tracker.start()),
    },
    { label: "Sincronizar ahora", enabled: authed, click: () => syncer.syncNow().catch(() => {}) },
    { type: "separator" },
    { label: "Salir", click: () => quitApp() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(authed ? `Itappi Agent — ${snap.running ? "activo" : "en pausa"} — ${formatHMS(snap.trackedSeconds)}` : "Itappi Agent — sin sesión");
}

function quitApp() {
  quitting = true;
  try {
    tracker.stop();
    store.data.day = { ...tracker.day };
    store.set("timerRunning", false);
    store.save({ immediate: true });
  } catch (err) {
    console.error("[quit] cleanup failed:", err.message);
  }
  // Best-effort final push so the last minutes are not stranded on disk.
  syncer
    .syncNow()
    .catch(() => {})
    .finally(() => {
      tracker.shutdown();
      app.quit();
    });
}

app.on("window-all-closed", () => {
  // Deliberately empty: the agent lives in the tray after the window closes.
});

app.on("before-quit", () => {
  quitting = true;
});

// --- state pushed to the renderer -----------------------------------------

function buildState() {
  return {
    version: app.getVersion(),
    authenticated: Boolean(api.token),
    serverUrl: store.get("serverUrl") || "",
    employee: store.get("employee"),
    tracker: tracker.snapshot(),
    sync: {
      pending: syncer.pending,
      lastSyncAt: syncer.lastSyncAt,
      error: syncer.lastError,
      inFlight: syncer.inFlight,
    },
    config,
    // Must pass the same args used in agent:set-autostart below — Electron on
    // Windows compares path+args against the registry Run key, so reading it
    // back without --hidden reports openAtLogin as false even when it's on.
    autoStart: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin,
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send("agent:state", buildState());
}

async function refreshConfig() {
  try {
    const remote = await api.config();
    config = {
      idleThresholdMinutes: remote.idle_threshold_minutes ?? DEFAULT_CONFIG.idleThresholdMinutes,
      syncIntervalSeconds: remote.sync_interval_seconds ?? DEFAULT_CONFIG.syncIntervalSeconds,
      bucketDurationSeconds: remote.bucket_duration_seconds ?? DEFAULT_CONFIG.bucketDurationSeconds,
      offlineRetentionDays: remote.offline_retention_days ?? DEFAULT_CONFIG.offlineRetentionDays,
      trackKeystrokes: remote.track_keystrokes ?? true,
      trackMouseClicks: remote.track_mouse_clicks ?? true,
      trackMouseMoves: remote.track_mouse_moves ?? true,
    };
    store.set("config", config);
    syncer.reschedule();
  } catch {
    // Keep the last known config; the agent must work through an outage.
  }
  pushState();
}

// --- IPC -------------------------------------------------------------------

ipcMain.handle("agent:get-state", () => buildState());

ipcMain.handle("agent:login", async (_event, { serverUrl, email, password }) => {
  api.configure({ baseUrl: serverUrl, token: null });

  try {
    const res = await api.login(email, password);
    api.configure({ token: res.token });

    store.set("serverUrl", api.baseUrl);
    store.setToken(res.token);
    store.set("employee", res.employee);

    await refreshConfig();
    syncer.start();
    tracker.restoreDay(store.get("day"));
    // Deliberately not starting the tracker here — see the same note in
    // bootstrap(). The employee presses "Iniciar" themselves.
    pingServer();
    if (app.isPackaged) setTimeout(() => checkForAgentUpdate(), UPDATE_FIRST_CHECK_DELAY_MS);

    pushState();
    updateTray();
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof ApiError && err.status === 401
        ? "Correo o contraseña incorrectos"
        : err.message || "No se pudo iniciar sesión";
    return { ok: false, error: message };
  }
});

ipcMain.handle("agent:logout", async () => {
  // Flush before dropping the token, or the pending queue becomes unsendable.
  tracker.stop();
  await syncer.syncNow().catch(() => {});
  syncer.stop();
  store.clearAuth();
  store.set("timerRunning", false);
  api.configure({ token: null });
  pushState();
  updateTray();
  return { ok: true };
});

ipcMain.handle("agent:start", () => {
  if (!api.token) return { ok: false, error: "Inicia sesión primero" };
  tracker.start();
  return { ok: true };
});

ipcMain.handle("agent:stop", () => {
  tracker.stop();
  syncer.syncNow().catch(() => {});
  return { ok: true };
});

ipcMain.handle("agent:sync-now", async () => {
  await syncer.syncNow().catch(() => {});
  return { ok: true, pending: syncer.pending, error: syncer.lastError };
});

ipcMain.handle("agent:set-autostart", (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    args: ["--hidden"],
  });
  pushState();
  return { ok: true };
});

ipcMain.handle("agent:hide", () => {
  if (win) win.hide();
  return { ok: true };
});
