/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Window-lifecycle and shutdown invariants for main.cjs.
 *
 * Origin: three identical native crashes on 2026-07-19 (EXC_BAD_ACCESS at
 * 0x238 on CrBrowserMain inside -[NSWindow __close], reached from
 * NativeWindowMac::Close). That crash was NOT reproduced and is not claimed to
 * be fixed here — it is a null dereference inside Electron 43.1.1, which app
 * code cannot cause directly.
 *
 * What these pin is the surrounding hardening: two dialog shapes that were
 * reproduced in isolation against Electron 43 on macOS, each of which stops a
 * quit from ever completing.
 *
 *   1. dialog.showMessageBox(win, ...) where `win` is already destroyed —
 *      attaches an AppKit sheet to a window that no longer hosts one, and
 *      app.quit() then never finishes.
 *   2. an ownerless (app-modal) dialog left open across a quit — nothing is
 *      left to dismiss it, so the quit blocks forever.
 *
 * A hung quit is what forces tests/e2e-electron to SIGKILL the shell, and a
 * SIGKILL mid-teardown is not a clean shutdown.
 *
 * main.cjs instantiates a real Electron `app` at import time, so — following
 * the convention in main-managed-runtime-ipc.test.cjs and axis-preload.test.cjs
 * — these assert at the source level rather than by executing the module.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function sectionAfter(marker, length = 1400) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `expected to find ${marker}`);
  return source.slice(start, start + length);
}

test("every message box goes through the shutdown-aware showDialog helper", () => {
  // dialog.showMessageBox may appear ONLY inside showDialog itself. A direct
  // call elsewhere is how an unparented or already-destroyed owner gets one.
  const direct = source.split("\n").filter((line) => /dialog\.showMessageBox/.test(line));
  assert.equal(
    direct.length,
    1,
    `dialog.showMessageBox must be called only inside showDialog, found:\n${direct.join("\n")}`,
  );
  assert.match(sectionAfter("function showDialog"), /if \(isQuitting\) return Promise\.resolve/);
  assert.match(sectionAfter("function showDialog"), /liveWindow\(owner\) \|\| liveWindow\(mainWindow\)/);
});

test("a quit latches before any window closes", () => {
  const body = sectionAfter('app.on("before-quit"', 400);
  assert.match(body, /isQuitting = true/);
});

test("file pickers never inherit a destroyed owner window", () => {
  const pickers = source.split("\n").filter((line) => /showOpenDialog\(/.test(line));
  assert.ok(pickers.length > 0, "expected at least one showOpenDialog call");
  for (const line of pickers) {
    assert.match(line, /liveWindow\(mainWindow\)/, `unguarded picker owner: ${line.trim()}`);
  }
});

test("did-fail-load refuses to raise a dialog during teardown and never stacks them", () => {
  const body = sectionAfter('window.webContents.on("did-fail-load"');
  assert.match(body, /if \(isQuitting \|\| !liveWindow\(window\) \|\| loadErrorDialogOpen\) return/);
  assert.match(body, /loadErrorDialogOpen = true/);
  assert.match(body, /loadErrorDialogOpen = false/);
});

test("a closed window only clears the shared reference if it is still the current one", () => {
  // Anchored on the main window's handler specifically — createBrowserWindow
  // registers an earlier window.on("closed") of its own.
  const body = sectionAfter("Only clear the shared reference", 400);
  assert.match(body, /if \(mainWindow === window\) mainWindow = null/);
});

test("the browser window's closed handler uses ids captured before teardown", () => {
  // Reading .id off a destroyed webContents throws from inside the handler,
  // stranding the very map entries the handler exists to clear. A BaseWindow
  // does not own its WebContentsViews, so either may already be gone.
  const body = sectionAfter("const toolbarId = toolbar.webContents.id", 700);
  assert.match(body, /browserWindows\.delete\(toolbarId\)/);
  assert.match(body, /browserViewIds\.delete\(viewId\)/);
  assert.doesNotMatch(body, /delete\(toolbar\.webContents\.id\)/);
  assert.doesNotMatch(body, /delete\(view\.webContents\.id\)/);
});

test("main window creation is single-flight so activate cannot orphan a window", () => {
  const body = sectionAfter("function ensureMainWindow", 500);
  assert.match(body, /mainWindowPromise \?\?= createMainWindow\(\)/);
  assert.match(body, /mainWindowPromise = null/);

  const activate = sectionAfter('app.on("activate"', 300);
  assert.match(activate, /ensureMainWindow\(\)/);
  assert.doesNotMatch(activate, /void createMainWindow\(\)/);
});

test("startup failures are reported rather than left as an unhandled rejection", () => {
  assert.match(source, /await ensureMainWindow\(\)/);
  const startup = sectionAfter("await runCrashReporterSmoke();", 400);
  assert.match(startup, /\}\)\.catch\(\(error\) => \{/);
  assert.match(startup, /operation: "app-startup"/);
});
