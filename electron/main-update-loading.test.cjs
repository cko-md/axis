/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Guards how main.cjs loads electron-updater.
 *
 * electron-updater is bundled ONLY into packaged builds (electron-builder adds
 * it); dev and the desktop e2e run unpackaged with it absent. A top-level
 * `require("electron-updater")` therefore threw MODULE_NOT_FOUND while
 * electron.launch was starting the shell, before any window existed — which the
 * desktop e2e saw as a beforeAll timeout, not a clear error. The require must
 * stay lazy and swallow its own absence so the shell always launches from
 * source; createUpdateController() no-ops when !app.isPackaged, so nothing is
 * lost when the updater is missing.
 *
 * main.cjs instantiates a real Electron `app` at import time, so — following the
 * convention in main-shutdown.test.cjs and axis-preload.test.cjs — this asserts
 * at the source level rather than by executing the module.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("electron-updater is never required at module top level", () => {
  // The only require may live inside loadAutoUpdater's try/catch. A top-level
  // destructuring require is exactly the crash-on-launch this guards against.
  assert.doesNotMatch(
    source,
    /^\s*const\s*\{[^}]*\}\s*=\s*require\(["']electron-updater["']\)/m,
    "electron-updater must not be destructured at module top level",
  );
});

test("electron-updater is loaded lazily and its absence is tolerated", () => {
  const start = source.indexOf("function loadAutoUpdater");
  assert.ok(start !== -1, "expected a loadAutoUpdater() helper");
  const body = source.slice(start, start + 400);
  assert.match(body, /try\s*\{/, "the require must be guarded by try/catch");
  assert.match(body, /require\(["']electron-updater["']\)\.autoUpdater/);
  assert.match(body, /catch[\s\S]*return null/, "a missing updater must resolve to null");

  // Every require of the module must be the guarded one — no other reference.
  const requires = source.match(/require\(["']electron-updater["']\)/g) || [];
  assert.equal(
    requires.length,
    1,
    `electron-updater must be required exactly once (inside loadAutoUpdater), found ${requires.length}`,
  );
});

test("the update controller is fed the lazily-loaded updater, not a module binding", () => {
  // createUpdateController must receive autoUpdater: loadAutoUpdater() so the
  // require only runs when the controller is actually built (packaged runs),
  // never at import.
  assert.match(source, /autoUpdater:\s*loadAutoUpdater\(\)/);
});
