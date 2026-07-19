/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "axis-preload.cjs"), "utf8");

test("trusted preload exposes only the browser and archive-bay bridges", () => {
  assert.match(source, /contextBridge\.exposeInMainWorld\("axisDesktop"/);
  assert.match(source, /ipcRenderer\.invoke\("axis-browser:open"/);
  assert.doesNotMatch(source, /contextBridge\.exposeInMainWorld\([^)]*,\s*ipcRenderer/);
});

test("archive-bay bridge is thin invoke/on wrappers with no raw path or flag parameters", () => {
  assert.match(source, /archiveBay = \{/);
  for (const channel of [
    "archive-bay:list",
    "archive-bay:import",
    "archive-bay:remove",
    "archive-bay:launch",
    "archive-bay:runtime-status",
    "archive-bay:runtime-choose",
  ]) {
    assert.match(source, new RegExp(`ipcRenderer\\.invoke\\("${channel}"`));
  }
  assert.match(source, /ipcRenderer\.on\("archive-bay:launch-state"/);
  // The renderer bridge never accepts a filesystem path parameter — import
  // takes an optional label only, launch/remove take an opaque contentId.
  assert.doesNotMatch(source, /archiveBay[\s\S]*romPath/);
  assert.doesNotMatch(source, /archiveBay[\s\S]*runtimePath/);
});

test("managed-runtime bridge (Phase 16.2) is thin invoke/on wrappers with no path, URL, or digest parameters", () => {
  assert.match(source, /archiveBayManagedRuntime = \{/);
  for (const channel of [
    "archive-bay:managed-runtime:manifest",
    "archive-bay:managed-runtime:status",
    "archive-bay:managed-runtime:install",
    "archive-bay:managed-runtime:remove",
  ]) {
    assert.match(source, new RegExp(`ipcRenderer\\.invoke\\("${channel}"\\)`));
  }
  assert.match(source, /ipcRenderer\.on\("archive-bay:managed-runtime:progress"/);
  assert.match(source, /exposeInMainWorld\("axisDesktop",\s*\{[\s\S]*archiveBayManagedRuntime/);
  // No method on this bridge accepts an argument at all — every call is a
  // fixed, zero-argument invoke; the manifest (URL/sha256/size) lives only
  // in the main process.
  assert.doesNotMatch(source, /archiveBayManagedRuntime[\s\S]*sha256/i);
  assert.doesNotMatch(source, /archiveBayManagedRuntime[\s\S]*romPath/);
  assert.doesNotMatch(source, /archiveBayManagedRuntime[\s\S]*runtimePath/);
});

test("trusted preload preserves compatibility with the previous hosted shell", () => {
  assert.match(source, /\.wv-overlay/);
  assert.match(source, /\/api\/proxy/);
  assert.match(source, /axis-sidebar/);
  assert.match(source, /hasAttribute\("aria-expanded"\)/);
});
