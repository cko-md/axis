/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * main.cjs instantiates a real Electron `app`, so (like the rest of this
 * suite) it isn't imported and executed under plain `node --test` — instead
 * this asserts the exact IPC wiring at the source level, the same
 * convention axis-preload.test.cjs uses for the preload script. It exists
 * to pin the Phase 16.2 managed-runtime IPC surface's security invariants:
 * every handler is sender-gated, install/remove both guard against
 * concurrent installs and remove-while-running, and every error path
 * returns a coded string rather than a raw Node/HTTP error.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function handlerBody(channel) {
  const marker = `ipcMain.handle("${channel}"`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `expected to find a handler for ${channel}`);
  // Slice out roughly the next 2000 chars — every handler in this file is
  // well under that, and this avoids needing a full brace-matching parser
  // just to scope the assertions below to a single handler body.
  return source.slice(start, start + 2000);
}

test("archive-bay:managed-runtime:manifest is sender-gated and never accepts a renderer argument", () => {
  const body = handlerBody("archive-bay:managed-runtime:manifest");
  assert.match(body, /if \(!isTrustedAxisSender\(event\)\) throw new Error/);
  assert.match(body, /async \(event\) => \{/);
});

test("archive-bay:managed-runtime:status is sender-gated and reports installing state", () => {
  const body = handlerBody("archive-bay:managed-runtime:status");
  assert.match(body, /if \(!isTrustedAxisSender\(event\)\) throw new Error/);
  assert.match(body, /managedRuntimeInstallInFlight/);
});

test("archive-bay:managed-runtime:install is sender-gated, refuses concurrent installs, and refuses to run while a title is launched", () => {
  const body = handlerBody("archive-bay:managed-runtime:install");
  assert.match(body, /if \(!isTrustedAxisSender\(event\)\) throw new Error/);
  assert.match(body, /if \(managedRuntimeInstallInFlight\) throw new Error\("RUNTIME_INSTALL_IN_PROGRESS"\)/);
  assert.match(body, /if \(activeArchiveBayLaunch\) throw new Error\("ARCHIVE_BAY_ALREADY_RUNNING"\)/);
  // The resolved executable must be re-canonicalized (realpath + file
  // check) before it is trusted as a runtimePath — the managed path is
  // never written into the library without going through the exact same
  // gate a BYO-chosen path goes through.
  assert.match(body, /canonicalizeRuntimePath\(executablePath\)/);
  assert.match(body, /library\.runtimePath = canonicalPath/);
  // Errors are coded, never raw (archiveBayRuntimeErrorMessage never
  // forwards error.message directly to the renderer).
  assert.match(body, /archiveBayRuntimeErrorMessage\(error\)/);
  assert.match(body, /finally \{\s*managedRuntimeInstallInFlight = false;/);
});

test("archive-bay:managed-runtime:remove is sender-gated, guards concurrent install/remove-while-running, and clears a matching active runtimePath", () => {
  const body = handlerBody("archive-bay:managed-runtime:remove");
  assert.match(body, /if \(!isTrustedAxisSender\(event\)\) throw new Error/);
  assert.match(body, /if \(managedRuntimeInstallInFlight\) throw new Error\("RUNTIME_INSTALL_IN_PROGRESS"\)/);
  assert.match(body, /if \(activeArchiveBayLaunch\) throw new Error\("ARCHIVE_BAY_ALREADY_RUNNING"\)/);
  assert.match(body, /removeRuntime\(\{ runtimesDir: archiveBayRuntimesDir, stateFilePath: archiveBayRuntimeStatePath \}\)/);
  assert.match(body, /library\.runtimePath = null/);
});

test("no managed-runtime handler ever forwards a raw error message to the renderer", () => {
  for (const channel of [
    "archive-bay:managed-runtime:manifest",
    "archive-bay:managed-runtime:install",
    "archive-bay:managed-runtime:remove",
  ]) {
    const body = handlerBody(channel);
    assert.doesNotMatch(body, /throw new Error\(error\.message\)/);
    assert.doesNotMatch(body, /throw error;/);
  }
});

test("the managed-runtime manifest is loaded from the bundled config file, not a renderer-suppliable path", () => {
  assert.match(source, /path\.join\(__dirname, "config", "archive-bay-runtimes\.json"\)/);
  assert.match(source, /validateManifest\(/);
});

test("progress events are pushed only to the trusted main window, never accept a renderer payload as input", () => {
  assert.match(source, /function sendManagedRuntimeProgress\(payload\) \{/);
  assert.match(source, /mainWindow\.webContents\.send\("archive-bay:managed-runtime:progress", payload\)/);
});
