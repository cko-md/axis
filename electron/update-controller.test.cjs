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

// electron-updater ships only inside packaged builds; dev and the desktop e2e
// run unpackaged with it absent, so main.cjs's loadAutoUpdater() hands this
// factory `null`. A null updater must degrade to the same inert controller as
// an unpackaged run rather than dereference autoUpdater.* and crash — the crash
// that hung `electron.launch` in the desktop e2e beforeAll.
test("a null updater degrades to the inert controller instead of crashing", async () => {
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: null,
    dialog: {},
    getMainWindow: () => null,
    observability: {},
  });
  assert.equal(await controller.checkForUpdates({ interactive: true }), false);
  // dispose() on the stub must be a no-op, not a call into a missing updater.
  assert.doesNotThrow(() => controller.dispose());
});

test("manual update checks provide visible up-to-date feedback", async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    updater.emit("update-not-available", { version: "1.2.3" });
  };
  // The manual menu path guarantees a live window before checking (main.cjs
  // ensures one), so feedback always has an owner to attach to.
  const owner = { isDestroyed: () => false };
  const messages = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: {
      showMessageBox: async (ownerArg, options) => {
        assert.equal(ownerArg, owner, "feedback must be owned, never app-modal");
        messages.push(options);
        return { response: 0 };
      },
    },
    getMainWindow: () => owner,
    observability: { captureException() {} },
  });

  await controller.checkForUpdates({ interactive: true });
  assert.equal(messages[0].title, "AXIS is up to date");
  controller.dispose();
});

// An ownerless message box is app-modal, outlives every window (macOS keeps
// the app alive with none), and Electron has no API to dismiss it — a quit
// that begins while one sits open never completes. So with no live window the
// prompt is skipped entirely rather than shown ownerless; the timers re-offer
// later and a downloaded update still installs on quit.
test("a background update prompt with no live window is skipped, not shown ownerless", async () => {
  const updater = new EventEmitter();
  let downloads = 0;
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "9.9.9" });
  };
  updater.downloadUpdate = async () => { downloads += 1; };
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async () => { throw new Error("an ownerless dialog must never open"); } },
    getMainWindow: () => null,
    observability: { captureException() {} },
  });

  await controller.checkForUpdates();
  assert.equal(downloads, 0);

  // A destroyed window is the same situation as no window.
  const gone = { isDestroyed: () => true };
  const controller2 = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async () => { throw new Error("an ownerless dialog must never open"); } },
    getMainWindow: () => gone,
    observability: { captureException() {} },
  });
  await controller2.checkForUpdates();
  assert.equal(downloads, 0);
  controller.dispose();
  controller2.dispose();
});

// These handlers fire from timers, so one can land after a quit has begun. An
// ownerless dialog raised at that point outlives every window and the app never
// finishes quitting — the failure that forces the Electron e2e teardown to
// SIGKILL the shell.
test("a quit in progress suppresses an update prompt that would block the quit", async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    updater.emit("update-not-available", { version: "9.9.9" });
  };
  const messages = [];
  let quitting = false;
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async (options) => { messages.push(options); return { response: 0 }; } },
    getMainWindow: () => null,
    observability: { captureException() {} },
    isQuitting: () => quitting,
  });

  quitting = true;
  await controller.checkForUpdates({ interactive: true });
  assert.equal(messages.length, 0);
  controller.dispose();
});

test("a quit in progress never starts an update download behind the user's back", async () => {
  const updater = new EventEmitter();
  let downloads = 0;
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "9.9.9" });
  };
  updater.downloadUpdate = async () => { downloads += 1; };
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async () => { throw new Error("no dialog may open during a quit"); } },
    getMainWindow: () => null,
    observability: { captureException() {} },
    isQuitting: () => true,
  });

  await controller.checkForUpdates();
  // The suppressed prompt resolves to a non-zero response, so the "Download
  // update" branch must not be taken.
  assert.equal(downloads, 0);
  controller.dispose();
});

// UPD-3 regression: the "Check for Updates…" menu item is live from launch, and
// two background timers (15s, 6h) also check. A background check must never
// silently swallow the acknowledgement a user's explicit manual check is owed.
// Before the fix, checkForUpdates did `manualCheck = interactive`, so a
// background check (interactive=false) landing while a manual check was in
// flight cleared the flag and onNotAvailable/onError dropped the dialog — the
// menu click appeared to do nothing.
test("a manual check's feedback survives a concurrent background check", async () => {
  const updater = new EventEmitter();
  // The updater is in-flight but emits nothing yet, so we can interleave a
  // background check before the (coalesced) single result event arrives.
  updater.checkForUpdates = async () => {};
  const owner = { isDestroyed: () => false };
  const messages = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: {
      showMessageBox: async (_owner, options) => { messages.push(options); return { response: 0 }; },
    },
    getMainWindow: () => owner,
    observability: { captureException() {} },
  });

  await controller.checkForUpdates({ interactive: true }); // user clicks the menu item
  await controller.checkForUpdates();                       // a background timer fires meanwhile
  // electron-updater coalesces both into one network check and emits one result.
  updater.emit("update-not-available", { version: "1.2.3" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(messages.length, 1, "the manual check must still be acknowledged");
  assert.equal(messages[0].title, "AXIS is up to date");
  controller.dispose();
});

// The same race on the error path: a manual check that ends in a reachability
// error must still surface "Could not check for updates" even if a background
// check ran between the click and the error event.
test("a manual check's error feedback survives a concurrent background check", async () => {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {};
  const owner = { isDestroyed: () => false };
  const messages = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: {
      showMessageBox: async (_owner, options) => { messages.push(options); return { response: 0 }; },
    },
    getMainWindow: () => owner,
    observability: { captureException() {} },
  });

  await controller.checkForUpdates({ interactive: true });
  await controller.checkForUpdates();
  updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(messages.length, 1, "the manual check's error must still be acknowledged");
  assert.equal(messages[0].title, "Could not check for updates");
  controller.dispose();
});

test("an empty bootstrap release channel is visible but not reported as an application fault", async () => {
  const updater = new EventEmitter();
  const captured = [];
  updater.checkForUpdates = async () => {
    updater.emit("error", new Error("No published versions on GitHub"));
  };
  const owner = { isDestroyed: () => false };
  const messages = [];
  const controller = createUpdateController({
    app: { isPackaged: true, getVersion: () => "1.2.3" },
    autoUpdater: updater,
    dialog: { showMessageBox: async (_owner, options) => { messages.push(options); return { response: 0 }; } },
    getMainWindow: () => owner,
    observability: { captureException: (error) => captured.push(error) },
  });

  await controller.checkForUpdates({ interactive: true });
  assert.equal(messages[0].title, "No desktop release is published yet");
  assert.equal(captured.length, 0);
  assert.equal(typeof updater.logger.error, "function");
  controller.dispose();
});
