/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "axis-preload.cjs"), "utf8");

test("trusted preload exposes only the browser bridge", () => {
  assert.match(source, /contextBridge\.exposeInMainWorld\("axisDesktop"/);
  assert.match(source, /ipcRenderer\.invoke\("axis-browser:open"/);
  assert.doesNotMatch(source, /contextBridge\.exposeInMainWorld\([^)]*,\s*ipcRenderer/);
});

test("trusted preload preserves compatibility with the previous hosted shell", () => {
  assert.match(source, /\.wv-overlay/);
  assert.match(source, /\/api\/proxy/);
  assert.match(source, /axis-sidebar/);
  assert.match(source, /hasAttribute\("aria-expanded"\)/);
});
