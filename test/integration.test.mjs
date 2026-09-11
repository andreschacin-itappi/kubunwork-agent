/**
 * End-to-end test of the main process against a stand-in backend.
 *
 * The agent is wired to Electron, which needs a desktop — so `electron` is
 * replaced by a stub that records what the app asks of it, and the real
 * src/main.js is loaded unmodified. The HTTP side is a real server that
 * validates every payload against the same constraints as
 * backend/src/schemas/activity.schema.ts, so anything the server would reject
 * fails here instead of in production.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

const BUCKET_SECONDS = 10; // keeps the test short; the tracker clamps to >= 10

// --- stand-in backend ------------------------------------------------------

function validateActivityBatch(body) {
  const errors = [];
  const isInt = (n) => Number.isInteger(n);

  if (!Array.isArray(body.records)) errors.push("records must be an array");
  else if (body.records.length > 500) errors.push("records exceeds 500");

  for (const [i, r] of (body.records || []).entries()) {
    const at = `records[${i}]`;
    // z.string().datetime() accepts an ISO-8601 UTC timestamp.
    if (typeof r.bucket_start !== "string" || Number.isNaN(Date.parse(r.bucket_start))) {
      errors.push(`${at}.bucket_start invalid`);
    }
    for (const field of ["keystrokes", "mouse_clicks", "mouse_moves", "mouse_distance"]) {
      if (!isInt(r[field]) || r[field] < 0) errors.push(`${at}.${field} must be a non-negative int`);
    }
    if (!isInt(r.activity_pct) || r.activity_pct < 0 || r.activity_pct > 100) {
      errors.push(`${at}.activity_pct out of range`);
    }
    if (typeof r.is_idle !== "boolean") errors.push(`${at}.is_idle must be boolean`);
    if (!isInt(r.active_seconds) || r.active_seconds < 0 || r.active_seconds > 60) {
      errors.push(`${at}.active_seconds out of 0-60`);
    }
    if (r.capture_mode !== undefined && !["tap", "fallback"].includes(r.capture_mode)) {
      errors.push(`${at}.capture_mode invalid`);
    }
  }

  for (const field of ["tracked_seconds", "idle_subtracted_seconds"]) {
    if (body[field] !== undefined && (!isInt(body[field]) || body[field] < 0)) {
      errors.push(`${field} must be a non-negative int`);
    }
  }
  return errors;
}

function startFakeBackend() {
  const state = { activityCalls: [], authHeaders: [], serverTrackedSeconds: 0, validationErrors: [] };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.url === "/api/agent/login" && req.method === "POST") {
        if (body.password !== "correcta") return send(401, { message: "Invalid credentials" });
        return send(200, {
          token: "agent-jwt-token",
          employee: { id: "emp-1", name: "Ana Pérez", email: body.email, department: "Marketing" },
        });
      }

      state.authHeaders.push(req.headers.authorization);

      if (req.url.startsWith("/api/config")) {
        return send(200, {
          idle_threshold_minutes: 5,
          sync_interval_seconds: 90,
          bucket_duration_seconds: BUCKET_SECONDS,
          offline_retention_days: 7,
          track_keystrokes: true,
          track_mouse_clicks: true,
          track_mouse_moves: true,
          source: "global",
        });
      }

      if (req.url === "/api/activity" && req.method === "POST") {
        const errors = validateActivityBatch(body);
        if (errors.length) {
          state.validationErrors.push(...errors);
          return send(400, { message: errors.join("; ") });
        }
        state.activityCalls.push(body);
        if (body.tracked_seconds != null) {
          state.serverTrackedSeconds = Math.max(
            Math.max(0, state.serverTrackedSeconds - (body.idle_subtracted_seconds || 0)),
            body.tracked_seconds
          );
        }
        return send(201, {
          inserted: body.records.length,
          failed: 0,
          total: body.records.length,
          errors: [],
          serverTrackedSeconds: state.serverTrackedSeconds,
        });
      }

      send(404, { message: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        state,
        url: `http://127.0.0.1:${server.address().port}`,
        // Keep-alive sockets from the agent's fetch would hold the event loop
        // open long after the test finishes.
        close() {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

// --- Electron stand-in -----------------------------------------------------

function installElectronStub({ userData, hookAvailable }) {
  const ipcHandlers = new Map();
  const sentToRenderer = [];
  const trayMenus = [];

  const app = Object.assign(new EventEmitter(), {
    _ready: null,
    getPath: () => userData,
    getVersion: () => "0.1.0",
    requestSingleInstanceLock: () => true,
    whenReady() {
      this._ready = new Promise((resolve) => setImmediate(resolve));
      return this._ready;
    },
    quit() {},
    // Real Electron on Windows only reports openAtLogin: true when the args
    // passed to getLoginItemSettings match what setLoginItemSettings stored —
    // callers that check with mismatched (or missing) args always get false
    // back, even though the registry entry exists.
    loginItem: { openAtLogin: false, args: [] },
    getLoginItemSettings(options = {}) {
      const args = options.args || [];
      const argsMatch = JSON.stringify(args) === JSON.stringify(this.loginItem.args);
      return { openAtLogin: this.loginItem.openAtLogin && argsMatch };
    },
    setLoginItemSettings(settings) {
      this.loginItem = { openAtLogin: false, args: [], ...settings };
    },
  });

  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = {
        send: (channel, payload) => sentToRenderer.push({ channel, payload }),
        setWindowOpenHandler: () => {},
      };
    }
    loadFile() {}
    once(event, fn) {
      // The app pushes its first state from ready-to-show.
      if (event === "ready-to-show") setImmediate(fn);
      return super.once(event, fn);
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    show() {}
    hide() {}
    focus() {}
    static getAllWindows() {
      return [];
    }
  }

  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(menu) {
      trayMenus.push(menu);
    }
  }

  const electron = {
    app,
    BrowserWindow,
    Tray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0 }),
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: () => {} },
  };

  // The agent runs a 1s tracker tick and a sync interval for its whole life.
  // Nothing tears those down (the real app exits with the process), so the
  // harness records them and clears them on restore, or the runner never exits.
  const intervals = new Set();
  const realSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    const handle = realSetInterval(...args);
    intervals.add(handle);
    return handle;
  };

  // Intercept both `electron` and the native hook: a real global hook cannot
  // attach on a headless build host, and letting it try would hang the test.
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "uiohook-napi") {
      if (!hookAvailable) throw new Error("libuiohook no disponible en este entorno");
      return { uIOhook: Object.assign(new EventEmitter(), { start() {}, stop() {} }), UiohookKey: {} };
    }
    return originalLoad(request, parent, isMain);
  };

  return {
    electron,
    ipcHandlers,
    sentToRenderer,
    trayMenus,
    invoke: (channel, payload) => ipcHandlers.get(channel)(null, payload),
    restore: () => {
      Module._load = originalLoad;
      global.setInterval = realSetInterval;
      for (const handle of intervals) clearInterval(handle);
      intervals.clear();
    },
  };
}

async function bootAgent({ hookAvailable = true } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "agent-int-"));
  const stub = installElectronStub({ userData, hookAvailable });

  // Fresh module registry each boot, so main.js re-runs its top-level wiring.
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  require("../src/main.js");

  await stub.electron.app._ready;
  await new Promise((resolve) => setImmediate(resolve));
  return { ...stub, userData };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- tests -----------------------------------------------------------------

test("the main process boots and registers every IPC channel", async () => {
  const agent = await bootAgent();
  try {
    for (const channel of [
      "agent:get-state",
      "agent:login",
      "agent:logout",
      "agent:start",
      "agent:stop",
      "agent:sync-now",
      "agent:set-autostart",
      "agent:hide",
    ]) {
      assert.ok(agent.ipcHandlers.has(channel), `falta el canal ${channel}`);
    }

    const state = await agent.invoke("agent:get-state");
    assert.equal(state.authenticated, false);
    assert.equal(state.tracker.running, false);
  } finally {
    agent.restore();
  }
});

test("wrong credentials surface a message and start nothing", async () => {
  const backend = await startFakeBackend();
  const agent = await bootAgent();
  try {
    const res = await agent.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "incorrecta",
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, "Correo o contraseña incorrectos");

    const state = await agent.invoke("agent:get-state");
    assert.equal(state.authenticated, false);
    assert.equal(state.tracker.running, false, "no debe medir sin sesión");
  } finally {
    agent.restore();
    backend.close();
  }
});

test("login pulls server config and authenticates every call, without starting tracking on its own", async () => {
  const backend = await startFakeBackend();
  const agent = await bootAgent();
  try {
    const res = await agent.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "correcta",
    });
    assert.equal(res.ok, true);

    const state = await agent.invoke("agent:get-state");
    assert.equal(state.authenticated, true);
    assert.equal(state.employee.name, "Ana Pérez");
    assert.equal(state.employee.department, "Marketing");
    assert.equal(state.tracker.running, false, "el empleado tiene que pulsar Iniciar explícitamente");

    // Config came from the server, not from the built-in defaults.
    assert.equal(state.config.bucketDurationSeconds, BUCKET_SECONDS);

    assert.ok(
      backend.state.authHeaders.every((h) => h === "Bearer agent-jwt-token"),
      "toda llamada autenticada lleva el token del agente"
    );
  } finally {
    agent.restore();
    backend.close();
  }
});

test("a real bucket reaches the server and passes the backend's validation", async () => {
  const backend = await startFakeBackend();
  const agent = await bootAgent();
  try {
    await agent.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "correcta",
    });
    await agent.invoke("agent:start");

    // Let the real clock close at least one bucket.
    await sleep((BUCKET_SECONDS + 2) * 1000);
    await agent.invoke("agent:sync-now");

    assert.deepEqual(backend.state.validationErrors, [], "el servidor no debe rechazar nada");

    const withRecords = backend.state.activityCalls.filter((c) => c.records.length > 0);
    assert.ok(withRecords.length >= 1, "debe llegar al menos un bucket");

    const record = withRecords[0].records[0];
    assert.equal(record.capture_mode, "tap", "con el hook disponible el modo es completo");
    assert.equal(new Date(record.bucket_start).getTime() % (BUCKET_SECONDS * 1000), 0);

    const state = await agent.invoke("agent:get-state");
    assert.equal(state.sync.pending, 0, "la cola queda vacía tras un envío correcto");
    assert.equal(state.sync.error, null);
  } finally {
    agent.restore();
    backend.close();
  }
});

test("without the input hook the agent still measures time, in fallback mode", async () => {
  const backend = await startFakeBackend();
  const agent = await bootAgent({ hookAvailable: false });
  try {
    await agent.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "correcta",
    });
    await agent.invoke("agent:start");

    const state = await agent.invoke("agent:get-state");
    assert.equal(state.tracker.captureMode, "fallback");
    assert.equal(state.tracker.running, true, "un hook bloqueado no debe impedir el cronómetro");

    await sleep((BUCKET_SECONDS + 2) * 1000);
    await agent.invoke("agent:sync-now");

    assert.deepEqual(backend.state.validationErrors, []);
    const withRecords = backend.state.activityCalls.filter((c) => c.records.length > 0);
    assert.ok(withRecords.length >= 1);
    assert.equal(withRecords[0].records[0].capture_mode, "fallback");
  } finally {
    agent.restore();
    backend.close();
  }
});

test("the session survives a restart of the agent", async () => {
  const backend = await startFakeBackend();
  const first = await bootAgent();
  let userData;
  try {
    await first.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "correcta",
    });
    await first.invoke("agent:start");
    userData = first.userData;
    await sleep(2500);
    await first.invoke("agent:sync-now");
  } finally {
    first.restore();
  }

  // Boot again against the same profile directory, as a reboot would.
  const stub = installElectronStub({ userData, hookAvailable: true });
  try {
    for (const key of Object.keys(require.cache)) delete require.cache[key];
    require("../src/main.js");
    await stub.electron.app._ready;
    await new Promise((resolve) => setImmediate(resolve));

    const state = await stub.invoke("agent:get-state");
    assert.equal(state.authenticated, true, "no debe pedir la contraseña otra vez");
    assert.equal(state.employee.name, "Ana Pérez");
    assert.ok(state.tracker.trackedSeconds >= 2, "conserva el tiempo del día");
    assert.equal(state.tracker.running, false, "no reanuda sola — hace falta volver a pulsar Iniciar");
  } finally {
    stub.restore();
    backend.close();
  }
});

test("an unreachable server queues locally instead of losing data", async () => {
  const backend = await startFakeBackend();
  const agent = await bootAgent();
  try {
    await agent.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "correcta",
    });
    await agent.invoke("agent:start");

    backend.close(); // the network drops mid-shift
    await sleep((BUCKET_SECONDS + 2) * 1000);
    await agent.invoke("agent:sync-now");

    const offline = await agent.invoke("agent:get-state");
    assert.ok(offline.sync.pending >= 1, "los buckets se acumulan en disco");
    assert.ok(offline.sync.error, "el fallo se reporta a la interfaz");
    assert.equal(offline.tracker.running, true, "sigue midiendo sin conexión");
  } finally {
    agent.restore();
  }
});

test("logging out flushes pending work before dropping the token", async () => {
  const backend = await startFakeBackend();
  const agent = await bootAgent();
  try {
    await agent.invoke("agent:login", {
      serverUrl: backend.url,
      email: "ana@empresa.com",
      password: "correcta",
    });
    await sleep(2500);

    const callsBefore = backend.state.activityCalls.length;
    await agent.invoke("agent:logout");

    assert.ok(backend.state.activityCalls.length > callsBefore, "sincroniza antes de cerrar sesión");

    const state = await agent.invoke("agent:get-state");
    assert.equal(state.authenticated, false);
    assert.equal(state.tracker.running, false);
  } finally {
    agent.restore();
    backend.close();
  }
});

test("the autostart toggle reaches the OS integration", async () => {
  const agent = await bootAgent();
  try {
    await agent.invoke("agent:set-autostart", true);
    // --hidden keeps the window out of the way on a login-triggered launch.
    assert.deepEqual(agent.electron.app.loginItem.args, ["--hidden"]);

    // The renderer only ever sees autoStart via agent:get-state — reading the
    // raw mock with mismatched args would mask a regression here.
    let state = await agent.invoke("agent:get-state");
    assert.equal(state.autoStart, true);

    await agent.invoke("agent:set-autostart", false);
    state = await agent.invoke("agent:get-state");
    assert.equal(state.autoStart, false);
  } finally {
    agent.restore();
  }
});
