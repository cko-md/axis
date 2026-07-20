/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Source-level assertions for the Phase 16.3 native-recomp IPC surface in
 * main.cjs. main.cjs instantiates a real Electron `app`, so — like
 * main-managed-runtime-ipc.test.cjs and axis-preload.test.cjs — this pins the
 * wiring by reading the source rather than executing the module.
 *
 * The invariants pinned here mirror 16.2's: every handler is sender-gated,
 * mutating handlers refuse to run concurrently with an install or a launch,
 * every error path returns a coded string (never a raw Node/HTTP error), the
 * manifest is loaded only from the bundled config file, and progress events
 * are pushed only to the trusted main window. Plus the recomp-specific point:
 * the user's original is chosen through the native file picker and handed to
 * the adapter's hash-validating stager — the renderer never supplies a path.
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
  return source.slice(start, start + 2200);
}

test("every recomp handler is sender-gated", () => {
  for (const channel of [
    "archive-bay:recomp:manifest",
    "archive-bay:recomp:status",
    "archive-bay:recomp:install",
    "archive-bay:recomp:choose-original",
    "archive-bay:recomp:remove",
    "archive-bay:recomp:launch",
  ]) {
    assert.match(handlerBody(channel), /if \(!isTrustedAxisSender\(event\)\) throw new Error/, channel);
  }
});

test("recomp:status reports installing state and never leaks a path", () => {
  const body = handlerBody("archive-bay:recomp:status");
  assert.match(body, /recompInstallInFlight/);
  assert.match(body, /originalReady: Boolean\(record\.original\)/);
});

test("recomp:install refuses concurrent installs and refuses to run while a title is launched", () => {
  const body = handlerBody("archive-bay:recomp:install");
  assert.match(body, /if \(recompInstallInFlight\) throw new Error\("RECOMP_INSTALL_IN_PROGRESS"\)/);
  assert.match(body, /if \(activeArchiveBayLaunch\) throw new Error\("ARCHIVE_BAY_ALREADY_RUNNING"\)/);
  assert.match(body, /archiveBayRecompErrorMessage\(error\)/);
  assert.match(body, /finally \{\s*recompInstallInFlight = false;/);
});

test("recomp:choose-original picks the original via the native file dialog and validates it in the adapter", () => {
  const body = handlerBody("archive-bay:recomp:choose-original");
  assert.match(body, /if \(recompInstallInFlight\) throw new Error\("RECOMP_INSTALL_IN_PROGRESS"\)/);
  assert.match(body, /if \(activeArchiveBayLaunch\) throw new Error\("ARCHIVE_BAY_ALREADY_RUNNING"\)/);
  // The original comes from the OS picker, then goes straight into the
  // hash-validating stager — the renderer supplies no path.
  assert.match(body, /await showFilePicker\(/);
  assert.match(body, /validateAndStageOriginal\(\{[\s\S]*originalFilePath: picked\.filePaths\[0\]/);
  assert.match(body, /archiveBayRecompErrorMessage\(error\)/);
});

test("recomp:remove guards concurrent install and remove-while-running", () => {
  const body = handlerBody("archive-bay:recomp:remove");
  assert.match(body, /if \(recompInstallInFlight\) throw new Error\("RECOMP_INSTALL_IN_PROGRESS"\)/);
  assert.match(body, /if \(activeArchiveBayLaunch\) throw new Error\("ARCHIVE_BAY_ALREADY_RUNNING"\)/);
  assert.match(body, /removeRecompPort\(\{/);
});

test("recomp:launch is single-flight, re-canonicalizes the command, and spawns with shell:false and no renderer args", () => {
  const body = handlerBody("archive-bay:recomp:launch");
  assert.match(body, /if \(activeArchiveBayLaunch\) throw new Error\("ARCHIVE_BAY_ALREADY_RUNNING"\)/);
  assert.match(body, /buildRecompLaunchSpec\(\{ portsDir: archiveBayRecompDir/);
  assert.match(body, /canonicalizeRuntimePath\(spec\.command\)/);
  assert.match(body, /spawn\(command, spec\.args, \{ shell: false, cwd: spec\.cwd \}\)/);
});

test("no recomp handler forwards a raw error message to the renderer", () => {
  for (const channel of [
    "archive-bay:recomp:manifest",
    "archive-bay:recomp:install",
    "archive-bay:recomp:choose-original",
    "archive-bay:recomp:remove",
    "archive-bay:recomp:launch",
  ]) {
    const body = handlerBody(channel);
    assert.doesNotMatch(body, /throw new Error\(error\.message\)/, channel);
    assert.doesNotMatch(body, /throw error;/, channel);
  }
});

test("the recomp manifest is loaded from the bundled config file, not a renderer-suppliable path", () => {
  assert.match(source, /path\.join\(__dirname, "config", "archive-bay-recomp-ports\.json"\)/);
  assert.match(source, /validateRecompManifest\(/);
});

test("recomp progress events are pushed only to the trusted main window", () => {
  assert.match(source, /function sendRecompProgress\(payload\) \{/);
  assert.match(source, /mainWindow\.webContents\.send\("archive-bay:recomp:progress", payload\)/);
});
