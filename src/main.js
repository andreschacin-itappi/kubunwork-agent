const path = require("path");
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerMonitor, safeStorage, shell } = require("electron");

const { Store } = require("./lib/store");
const { Api, ApiError } = require("./lib/api");
const { Tracker } = require("./lib/tracker");
const { Syncer } = require("./lib/sync");

/** Mirrors the server's fallback block in config.routes.ts, so a first run with
 *  no network still measures with the same parameters the server would send. */
const DEFAULT_CONFIG = {
  idleThresholdMinutes: 5,
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
  api.configure({ baseUrl: store.get("serverUrl"), token: store.getToken() });

  if (store.get("config")) config = { ...DEFAULT_CONFIG, ...store.get("config") };

  tracker = new Tracker({ powerMonitor, getConfig: () => config });
  tracker.restoreDay(store.get("day"));
  tracker.initCapture();

  syncer = new Syncer({ api, store, tracker, getConfig: () => config });

  wireEvents();
  createWindow();
  createTray();

  if (api.token) {
    // Resume where the previous run left off before the employee touches
    // anything — a reboot mid-shift should not silently stop tracking.
    refreshConfig();
    syncer.start();
    if (store.get("timerRunning")) tracker.start();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
  powerMonitor.on("suspend", () => {
    if (tracker.running) {
      tracker.stop();
      store.set("resumeAfterWake", true);
    }
    syncer.syncNow().catch(() => {});
  });

  powerMonitor.on("resume", () => {
    if (store.get("resumeAfterWake")) {
      store.set("resumeAfterWake", false);
      if (api.token) tracker.start();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 660,
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
    autoStart: app.getLoginItemSettings().openAtLogin,
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
    tracker.start();

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
