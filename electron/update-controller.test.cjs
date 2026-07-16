/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdateController } = require("./update-controller.cjs");

test("source builds do not query the production update channel", async () => {
  const controller = createUpdateController({
    app: { isPackaged: false },
    autoUpdater: {},
    dialog: {},
    getMainWindow: () => null,
    observability: {},
  });
  assert.equal(await controller.checkForUpdates(), false);
});

test("manual update checks provide visible up-to-date feedback", async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    updater.emit("update-not-available", { version: "1.2.3" });
  };
  const messages = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async (options) => { messages.push(options); return { response: 0 }; } },
    getMainWindow: () => null,
    observability: { captureException() {} },
  });

  await controller.checkForUpdates({ interactive: true });
  assert.equal(messages[0].title, "AXIS is up to date");
  controller.dispose();
});

test("an empty bootstrap release channel is visible but not reported as an application fault", async () => {
  const updater = new EventEmitter();
  const captured = [];
  updater.checkForUpdates = async () => {
    updater.emit("error", new Error("No published versions on GitHub"));
  };
  const messages = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async (options) => { messages.push(options); return { response: 0 }; } },
    getMainWindow: () => null,
    observability: { captureException: (error) => captured.push(error) },
  });

  await controller.checkForUpdates({ interactive: true });
  assert.equal(messages[0].title, "No desktop release is published yet");
  assert.equal(captured.length, 0);
  assert.equal(typeof updater.logger.error, "function");
  controller.dispose();
});
