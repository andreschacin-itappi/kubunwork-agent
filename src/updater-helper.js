/**
 * Runs detached from the main app, via:
 *   ELECTRON_RUN_AS_NODE=1 <execPath> updater-helper.js <pid> <appDir> <stagedDir> <execPath>
 * (see applyStagedUpdateAndRestart in main.js).
 *
 * Windows keeps the native uiohook addon (and, generally, any file the app
 * has open) locked for as long as the process that loaded it is alive, so
 * this waits for the parent to actually exit before touching anything on
 * disk, then relaunches it. It intentionally has no Electron dependency —
 * ELECTRON_RUN_AS_NODE turns the same .exe into a plain Node runtime, which
 * is what lets this ship without bundling a separate Node binary.
 */
const { spawn } = require("child_process");
const { applyUpdate } = require("./lib/update-apply");

const [, , pidArg, appDir, stagedDir, execPath] = process.argv;
const pid = parseInt(pidArg, 10);
const WAIT_TIMEOUT_MS = 30000;

function isAlive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await sleep(300);
  }

  if (isAlive(pid)) {
    // Something kept the previous instance alive (a hung shutdown). Leaving
    // the current install untouched and trying again on the next check beats
    // swapping files out from under a process that still has them open.
    console.error("[updater-helper] el proceso anterior no cerró a tiempo; se cancela esta actualización");
    return;
  }

  try {
    applyUpdate(appDir, stagedDir);
  } catch (err) {
    // applyUpdate already rolled back to the previous version on failure, so
    // relaunching below still starts a working install.
    console.error("[updater-helper] no se pudo aplicar la actualización:", err.message);
  }

  spawn(execPath, ["--hidden"], { detached: true, stdio: "ignore" }).unref();
}

main();
