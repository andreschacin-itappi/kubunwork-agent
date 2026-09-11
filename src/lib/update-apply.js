const fs = require("fs");

/** rename() fails with EXDEV across drives (staging in userData vs. an app
 *  installed on another volume) — fall back to copy+delete in that case. */
function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Swaps `appDir` (the running install's resources/app) for `stagedDir` (a
 * verified, already-extracted new version). Only safe to call once nothing
 * still has appDir's files open — see updater-helper.js, which waits for the
 * main process to exit first.
 *
 * Keeps one backup (`appDir.bak`) for the duration of the swap so a failure
 * partway through (disk full, a stray lock) restores the previous version
 * instead of leaving the employee with an install that won't start.
 */
function applyUpdate(appDir, stagedDir) {
  const backupDir = `${appDir}.bak`;
  fs.rmSync(backupDir, { recursive: true, force: true });

  moveDir(appDir, backupDir);
  try {
    moveDir(stagedDir, appDir);
  } catch (err) {
    fs.rmSync(appDir, { recursive: true, force: true });
    moveDir(backupDir, appDir);
    throw err;
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
}

module.exports = { applyUpdate, moveDir };
