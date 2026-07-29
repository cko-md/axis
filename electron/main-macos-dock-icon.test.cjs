/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Package metadata, not a runtime PNG override, owns AXIS's macOS Dock icon.
 *
 * electron-builder embeds build/icon.icns as the bundle icon. Calling
 * app.dock.setIcon(build/icon.png) after launch replaces that multi-resolution
 * asset with the flat renderer PNG, which looks wrong next to native apps.
 * main.cjs is deliberately source-tested because importing it creates a real
 * Electron app instance.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const mainSource = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const builderSource = readFileSync(path.join(__dirname, "electron-builder.cjs"), "utf8");

test("macOS Dock rendering stays owned by the packaged icns asset", () => {
  assert.doesNotMatch(
    mainSource,
    /\bnativeImage\b/,
    "main.cjs must not load a PNG with nativeImage for a runtime Dock override",
  );
  assert.doesNotMatch(
    mainSource,
    /\bapp\.dock\.setIcon\s*\(/,
    "main.cjs must not replace the bundle Dock icon at runtime",
  );
  assert.match(
    builderSource,
    /mac:\s*\{[\s\S]*?icon:\s*["']build\/icon\.icns["']/,
    "electron-builder must retain the macOS bundle icon",
  );
});

test("window icons continue to use the packaged renderer icon off the Dock", () => {
  assert.match(mainSource, /icon:\s*appIconPath/, "BrowserWindow icon behavior must remain intact");
});
