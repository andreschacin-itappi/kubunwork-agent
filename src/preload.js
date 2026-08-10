const { contextBridge, ipcRenderer } = require("electron");

/**
 * The renderer runs with contextIsolation on and no Node access. Everything it
 * can do is listed here — there is no generic "invoke any channel" escape
 * hatch, so a compromised page cannot reach the filesystem or the token.
 */
contextBridge.exposeInMainWorld("agent", {
  getState: () => ipcRenderer.invoke("agent:get-state"),
  login: (credentials) => ipcRenderer.invoke("agent:login", credentials),
  logout: () => ipcRenderer.invoke("agent:logout"),
  start: () => ipcRenderer.invoke("agent:start"),
  stop: () => ipcRenderer.invoke("agent:stop"),
  syncNow: () => ipcRenderer.invoke("agent:sync-now"),
  setAutoStart: (enabled) => ipcRenderer.invoke("agent:set-autostart", enabled),
  hide: () => ipcRenderer.invoke("agent:hide"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("agent:state", listener);
    return () => ipcRenderer.removeListener("agent:state", listener);
  },
});
