/* eslint-disable @typescript-eslint/no-require-imports */
const {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  WebContentsView,
  crashReporter,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require("electron");
// electron-updater ships only inside packaged builds (electron-builder bundles
// it); dev and the desktop e2e run unpackaged and never install it. Requiring
// it at module load therefore threw MODULE_NOT_FOUND before any window opened,
// which crashed `electron.launch` and surfaced as a beforeAll timeout in the
// desktop e2e. createUpdateController() no-ops when !app.isPackaged, so the
// updater is never exercised from source — load it lazily and tolerate its
// absence (a packaged build always resolves it).
function loadAutoUpdater() {
  try {
    return require("electron-updater").autoUpdater;
  } catch {
    return null;
  }
}
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  ArchiveBayError,
  buildLaunchSpawnArgs,
  buildLegacyTitleRecord,
  canonicalizeImportPath,
  canonicalizeRuntimePath,
  loadLibrary,
  saveLibrary,
  sha256File,
  toPublicLegacyTitle,
} = require("./archive-bay.cjs");
const {
  ArchiveBayRuntimeError,
  getPlatformRelease,
  installRuntime,
  loadRuntimeState,
  removeRuntime,
  resolveInstalledExecutablePath,
  resolvePlatformKey,
  validateManifest,
} = require("./archive-bay-runtime.cjs");
const {
  buildRecompLaunchSpec,
  getPort: getRecompPort,
  getPortPlatformRelease: getRecompPortPlatformRelease,
  installPort: installRecompPort,
  loadRecompState,
  recompErrorCode,
  removePort: removeRecompPort,
  validateAndStageOriginal,
  validateRecompManifest,
} = require("./archive-bay-recomp.cjs");
const {
  compatibilityForUrl,
  createManagedExtensionManager,
} = require("./browser-capabilities.cjs");
const { createDesktopObservability } = require("./desktop-observability.cjs");
const { findDeepLinkInArgv, parseDeepLink } = require("./deep-links.cjs");
const { resolveRuntimeConfig } = require("./runtime-config.cjs");
const { createUpdateController } = require("./update-controller.cjs");

app.enableSandbox();

// Exactly one main process. A second launch (including one triggered by an
// axis:// link) must hand off to the running instance rather than starting a
// rival: Archive Bay's runtime install/remove guards, the updater, and the
// single mainWindow reference all assume one process owns them.
//
// A bare top-level return is legal — Node wraps every CJS module in a function —
// and it exits before any window, IPC, or dev-server code runs in the loser.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}

const startsDevServer = process.argv.includes("--dev");
const runtime = resolveRuntimeConfig({ isPackaged: app.isPackaged });
const axisUrl = runtime.axisUrl;
const axisOrigin = runtime.axisOrigin;
const appIconPath = path.join(__dirname, "build", "icon.png");
const readerFileUrl = pathToFileURL(path.join(__dirname, "reader.html")).href;
const browserWindows = new Map();
const browserViewIds = new Set();
const readerArticles = new Map();
const observability = createDesktopObservability({ crashReporter, runtime });
// Phase 16.1 Archive Bay: desktop-only, bring-your-own-emulator local
// library. See docs/axis-redesign/adr/0005-archive-bay-emulator-native-port-separation.md.
// The library file (contentId -> {romPath, sha256, ...} plus the configured
// runtime executable path) lives in userData, never in Supabase, and is
// never sent to the renderer in raw form (see toPublicLegacyTitle).
const archiveBayLibraryPath = path.join(app.getPath("userData"), "archive-bay", "library.json");
let archiveBayLibraryPromise = null;
let activeArchiveBayLaunch = null; // { contentId, child } | null — one launch at a time
// Phase 16.2 managed melonDS runtime (ADR-0005, Option B). The manifest is
// the SOLE source of download URLs/sizes/digests — it ships inside the asar
// (electron/config/), never renderer-suppliable. Installed runtime bytes
// live in userData, outside the asar, verified by sha256 before activation.
// This install-state file is intentionally separate from archive-bay.cjs's
// library.json so the BYO library schema never has to change; once a
// managed runtime is installed, its resolved executable path is still
// routed through the exact same canonicalizeRuntimePath/library.runtimePath
// contract as a BYO runtime, so the spawn contract is not forked.
const archiveBayRuntimesDir = path.join(app.getPath("userData"), "archive-bay", "runtimes");
const archiveBayRuntimeStatePath = path.join(archiveBayRuntimesDir, "state.json");
let cachedArchiveBayRuntimeManifest = null;
let managedRuntimeInstallInFlight = false;
// Phase 16.3 native-recompilation ports (ADR-0005, option 4). Same shape as
// 16.2: the manifest (electron/config/archive-bay-recomp-ports.json) is the
// sole, asar-bundled source of every port's binary download and of the sha256
// of the original the user must supply — none of it renderer-suppliable. AXIS
// downloads ONLY the port binary and NEVER any original game asset; the user's
// original is validated by hash and staged locally by archive-bay-recomp.cjs.
const archiveBayRecompDir = path.join(app.getPath("userData"), "archive-bay", "recomp");
const archiveBayRecompStatePath = path.join(archiveBayRecompDir, "state.json");
let cachedArchiveBayRecompManifest = null;
let recompInstallInFlight = false;
let devServer = null;
let mainWindow = null;
let mainWindowPromise = null; // single-flight guard for createMainWindow()
let updateController = null;
let extensionManager = null;
// Set the moment a quit begins. Every dialog below consults it, because a
// dialog raised during teardown is the one thing that can stop the app from
// ever finishing its quit — see showDialog().
let isQuitting = false;
let loadErrorDialogOpen = false;

function liveWindow(candidate) {
  return candidate && !candidate.isDestroyed() ? candidate : null;
}

/**
 * Every dialog in the main process is raised against a window that may already
 * be gone: did-fail-load fires while a window is tearing down, the updater
 * fires on a timer, and Archive Bay's pickers sit behind async IPC.
 *
 * Two shapes hang the app, both verified against Electron 43 on macOS:
 *   - passing a DESTROYED BrowserWindow attaches an AppKit sheet to a window
 *     that no longer hosts one, and app.quit() then never completes;
 *   - an OWNERLESS (app-modal) dialog outlives every window, so quitting waits
 *     on a dialog with nothing left to dismiss it.
 * A hung quit is what forces the Electron e2e teardown to SIGKILL the shell.
 *
 * So: resolve an owner at call time and prefer a live one (a sheet dies with
 * its parent window), and refuse to open anything once quitting has started.
 */
function showDialog(options, { owner = null } = {}) {
  if (isQuitting) return Promise.resolve({ response: -1, canceled: true, checkboxChecked: false });
  const parent = liveWindow(owner) || liveWindow(mainWindow);
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

/**
 * File pickers share showDialog()'s teardown rules, via a different Electron
 * API the message-box hardening cannot see: a quit in progress must never
 * gain a dialog (IPC keeps arriving between before-quit and the window's
 * close), and a picker with no live owner would be the ownerless app-modal
 * shape that blocks the quit. Both refuse as a canceled pick.
 */
function showFilePicker(options) {
  if (isQuitting) return Promise.resolve({ canceled: true, filePaths: [] });
  const parent = liveWindow(mainWindow);
  if (!parent) return Promise.resolve({ canceled: true, filePaths: [] });
  return dialog.showOpenDialog(parent, options);
}

function normalizeWebUrl(raw) {
  const value = String(raw || "").trim();
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
  return url.href;
}

function hostnameFor(raw) {
  try {
    return new URL(raw).hostname.slice(0, 120);
  } catch {
    return "unknown";
  }
}

function isTrustedAxisSender(event) {
  try {
    return new URL(event.senderFrame.url).origin === axisOrigin;
  } catch {
    return false;
  }
}

function stateFor(record) {
  const extensionState = extensionManager?.getState();
  return {
    url: record.view.webContents.getURL(),
    title: record.view.webContents.getTitle(),
    loading: record.view.webContents.isLoading(),
    canGoBack: record.view.webContents.navigationHistory.canGoBack(),
    canGoForward: record.view.webContents.navigationHistory.canGoForward(),
    error: record.lastError,
    compatibility: compatibilityForUrl(record.view.webContents.getURL(), {
      passwordForm: record.passwordForm,
    }),
    extensions: {
      loaded: extensionState?.loaded.length || 0,
      failed: extensionState?.failed.length || 0,
    },
  };
}

function sendBrowserState(record) {
  if (!record.toolbar.webContents.isDestroyed()) {
    record.toolbar.webContents.send("axis-browser:state", stateFor(record));
  }
}

function showBrowserError(record, message) {
  record.lastError = String(message).slice(0, 240);
  sendBrowserState(record);
}

async function detectPasswordForm(record) {
  if (record.view.webContents.isDestroyed()) return;
  const navigationUrl = record.view.webContents.getURL();
  try {
    const passwordForm = await record.view.webContents.executeJavaScript(
      `Boolean(document.querySelector(
        'input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]'
      ))`,
      true,
    );
    if (navigationUrl !== record.view.webContents.getURL()) return;
    record.passwordForm = Boolean(passwordForm);
  } catch {
    record.passwordForm = false;
  }
  sendBrowserState(record);
}

async function showBrowserCapabilities(record) {
  const extensionState = extensionManager?.getState() || { loaded: [], failed: [] };
  const broadAccessCount = extensionState.loaded.filter((item) => item.broadHostAccess).length;
  const detail = [
    `Managed unpacked extensions: ${extensionState.loaded.length} loaded, ${extensionState.failed.length} failed.`,
    broadAccessCount ? `${broadAccessCount} loaded extension(s) can access all sites.` : "No loaded extension declares access to all sites.",
    "",
    "Chrome Web Store: unavailable; Electron supports only a subset of extension APIs.",
    "Proprietary DRM: Widevine is not bundled in the stock Electron build.",
    "Passwords: AXIS never captures, stores, syncs, or autofills website credentials.",
    "",
    "Use the system-browser action for DRM services, Chrome/Edge Sync, or installed password-manager extensions.",
  ].join("\n");
  const result = await showDialog({
    type: "info",
    buttons: ["Open extension folder", "Reload extensions", "Open page externally", "Close"],
    defaultId: 3,
    cancelId: 3,
    title: "AXIS Browser capabilities",
    message: "Browser compatibility and privacy",
    detail,
  }, { owner: record.window });

  if (result.response === 0) {
    await extensionManager?.openFolder();
  } else if (result.response === 1) {
    const next = await extensionManager?.reload();
    sendBrowserState(record);
    await showDialog({
      type: next?.failed.length ? "warning" : "info",
      title: "Browser extensions reloaded",
      message: `${next?.loaded.length || 0} extension(s) loaded.`,
      detail: next?.failed.length
        ? `${next.failed.length} extension(s) failed. Open the extension folder and review enabled.json.`
        : "Only explicitly enabled unpacked extensions are active.",
    }, { owner: record.window });
  } else if (result.response === 2) {
    const url = record.view.webContents.getURL();
    if (url) await shell.openExternal(normalizeWebUrl(url));
  }
}

function createBrowserWindow(rawUrl, requestedTitle) {
  // An absent URL is the explicit "open the browser with no page yet" case (the
  // Topbar's Mini Browser button). It is NOT an error: normalizeWebUrl would
  // throw on "", the IPC call would reject, and the renderer would silently fall
  // back to the in-app iframe — which is exactly how the primary browser entry
  // point ended up never using the native browser on desktop.
  const hasUrl = String(rawUrl || "").trim().length > 0;
  const url = hasUrl ? normalizeWebUrl(rawUrl) : null;
  const window = new BaseWindow({
    title: requestedTitle || "AXIS Browser",
    width: 1220,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0b0d11",
    icon: appIconPath,
  });

  const toolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "browser-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.contentView.addChildView(toolbar);
  void toolbar.webContents.loadFile(path.join(__dirname, "browser.html"));

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: "persist:axis-browser",
    },
  });
  browserViewIds.add(view.webContents.id);
  window.contentView.addChildView(view);

  const record = { window, toolbar, view, lastError: "", passwordForm: false };
  browserWindows.set(toolbar.webContents.id, record);

  const layout = () => {
    const [width, height] = window.getContentSize();
    toolbar.setBounds({ x: 0, y: 0, width, height: 62 });
    view.setBounds({ x: 0, y: 62, width, height: Math.max(0, height - 62) });
  };
  layout();
  window.on("resize", layout);

  view.webContents.on("did-start-loading", () => {
    record.lastError = "";
    record.passwordForm = false;
    sendBrowserState(record);
  });
  for (const eventName of ["did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) {
    view.webContents.on(eventName, () => sendBrowserState(record));
  }
  view.webContents.on("page-title-updated", (_event, title) => {
    window.setTitle(title ? `${title} — AXIS Browser` : "AXIS Browser");
  });
  view.webContents.on("dom-ready", () => {
    void detectPasswordForm(record);
  });
  view.webContents.on("did-fail-load", (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const hostname = hostnameFor(validatedUrl || view.webContents.getURL());
    showBrowserError(
      record,
      `Could not load ${hostname}. The site may reject embedded Chromium; use ↗ to continue in your system browser.`,
    );
    observability.captureException(new Error(`Browser navigation failed (${errorCode})`), {
      errorCode,
      hostname,
      operation: "browser-navigation",
    });
  });
  view.webContents.on("render-process-gone", (_event, details) => {
    showBrowserError(record, "The page process stopped unexpectedly. Reload the page or use ↗ to open it externally.");
    observability.captureMessage("Browser renderer process stopped", {
      exitCode: details.exitCode,
      operation: "browser-renderer",
      reason: details.reason,
    });
  });
  view.webContents.on("will-navigate", (event, nextUrl) => {
    try {
      normalizeWebUrl(nextUrl);
    } catch {
      event.preventDefault();
      showBrowserError(record, "AXIS blocked a navigation to an unsupported URL scheme.");
    }
  });
  view.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    try {
      void view.webContents.loadURL(normalizeWebUrl(nextUrl));
    } catch {
      showBrowserError(record, "AXIS blocked a popup using an unsupported URL scheme.");
    }
    return { action: "deny" };
  });

  // Captured now, not in the closed handler. A BaseWindow does not own its
  // WebContentsViews, so by the time "closed" fires either webContents may
  // already be gone — and reading .id off a destroyed webContents throws from
  // inside the event handler, stranding the map entries it was meant to clear.
  const toolbarId = toolbar.webContents.id;
  const viewId = view.webContents.id;
  window.on("closed", () => {
    window.off("resize", layout);
    browserWindows.delete(toolbarId);
    browserViewIds.delete(viewId);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
  });

  if (url) void view.webContents.loadURL(url);
  return true;
}

function recordFor(event) {
  return browserWindows.get(event.sender.id);
}

// browserWindows is keyed by TOOLBAR webContents id; session-level handlers are
// handed the content VIEW instead, so they cannot look a window up directly.
function recordForViewId(webContentsId) {
  for (const record of browserWindows.values()) {
    if (!record.view.webContents.isDestroyed() && record.view.webContents.id === webContentsId) return record;
  }
  return null;
}

/**
 * Downloads were entirely unpoliced: no session had a will-download listener,
 * so a download went wherever Chromium decided with whatever filename the
 * server supplied.
 *
 * The filename is attacker-controlled, so it is reduced to a basename and
 * stripped of path and shell-significant characters before use. Nothing is ever
 * auto-opened on completion — not executables, not anything — because opening a
 * downloaded file is the step that turns a download into code execution.
 */
function attachDownloadPolicy(targetSession, label) {
  targetSession.on("will-download", (_event, item) => {
    const rawName = item.getFilename() || "download";
    const safeName =
      path
        .basename(rawName)
        .replace(/[ -]/g, "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 200) || "download";

    item.setSavePath(path.join(app.getPath("downloads"), safeName));

    item.once("done", (_doneEvent, state) => {
      if (state === "completed") return;
      // A failed download is a visible event, not a silent no-op.
      observability.captureMessage("Download did not complete", {
        operation: "download",
        session: label,
        state,
      });
    });
  });
}

/**
 * The main window loads the hosted AXIS origin into session.defaultSession,
 * which had NO permission policy — so that remote origin inherited Chromium's
 * permissive defaults for camera, microphone, geolocation and more.
 *
 * The allowlist below is what the web app actually uses (audio-only capture for
 * voice notes, notifications for the timers, geolocation for the weather
 * widget). Everything else is denied, and permission is only ever granted to
 * the AXIS origin itself.
 */
function configureDefaultSessionPermissions() {
  const allowed = new Set(["media", "notifications", "geolocation"]);

  const isAxisOrigin = (requestingUrl) => {
    try {
      return new URL(requestingUrl).origin === axisOrigin;
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || contents?.getURL?.() || "";
    if (!isAxisOrigin(requestingUrl) || !allowed.has(permission)) {
      callback(false);
      return;
    }
    // Voice notes use audio only; there is no camera or screen capture anywhere
    // in the app, so a video request is a request the app did not make.
    if (permission === "media" && details?.mediaTypes?.includes("video")) {
      callback(false);
      return;
    }
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return allowed.has(permission) && requestingOrigin === axisOrigin;
  });

  // No feature in AXIS captures a screen or window.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));

  attachDownloadPolicy(session.defaultSession, "default");
}

async function configureBrowserSession() {
  configureDefaultSessionPermissions();
  const browserSession = session.fromPartition("persist:axis-browser");
  attachDownloadPolicy(browserSession, "browser");
  const promptable = new Set(["media", "geolocation", "notifications", "clipboard-read"]);
  const chromiumUserAgent = browserSession
    .getUserAgent()
    .replace(/\sElectron\/[^\s]+/g, "")
    .replace(/\sAXIS\/[^\s]+/g, "");
  browserSession.setUserAgent(chromiumUserAgent);

  browserSession.setPermissionCheckHandler((webContents, permission) => (
    Boolean(webContents && browserViewIds.has(webContents.id) && promptable.has(permission))
  ));
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!browserViewIds.has(webContents.id) || !promptable.has(permission)) {
      callback(false);
      return;
    }
    let hostname = "this site";
    try {
      hostname = new URL(details.requestingUrl).hostname;
    } catch {
      // Keep the generic label.
    }
    // Suppressed during quit, which resolves to a non-zero response and so
    // denies — a permission prompt nobody can answer must not grant.
    void showDialog({
      type: "question",
      buttons: ["Allow once", "Block"],
      defaultId: 1,
      cancelId: 1,
      title: "Website permission",
      message: `Allow ${hostname} to use ${permission}?`,
      detail: "The permission applies only to this request in the isolated AXIS browser session.",
    }, { owner: recordForViewId(webContents.id)?.window }).then(({ response }) => callback(response === 0));
  });
  browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  extensionManager = createManagedExtensionManager({
    app,
    browserSession,
    shell,
  });
  try {
    const extensionState = await extensionManager.initialize();
    if (extensionState.failed.length) {
      observability.captureMessage("Managed browser extensions failed to initialize", {
        failedCount: extensionState.failed.length,
        operation: "browser-extensions",
      });
    }
  } catch (error) {
    observability.captureException(error, { operation: "browser-extensions-initialize" });
  }
}

function getArchiveBayLibrary() {
  archiveBayLibraryPromise ??= loadLibrary(archiveBayLibraryPath).catch((error) => {
    archiveBayLibraryPromise = null;
    throw error;
  });
  return archiveBayLibraryPromise;
}

async function persistArchiveBayLibrary(library) {
  await saveLibrary(archiveBayLibraryPath, library);
  archiveBayLibraryPromise = Promise.resolve(library);
}

function sendArchiveBayLaunchState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("archive-bay:launch-state", state);
}

function archiveBayErrorMessage(error) {
  // Coded, path-free error codes only — never forward a raw filesystem
  // path or Node error message (e.g. child_process ENOENT errors embed the
  // spawned command's full path) to the renderer.
  if (error instanceof ArchiveBayError) return error.code;
  return "ARCHIVE_BAY_UNKNOWN_ERROR";
}

function archiveBayRuntimeErrorMessage(error) {
  // Same coded-error-only rule as archiveBayErrorMessage — never forward a
  // raw path, URL, or Node error message to the renderer.
  if (error instanceof ArchiveBayRuntimeError) return error.code;
  return "RUNTIME_UNKNOWN_ERROR";
}

function getArchiveBayRuntimeManifest() {
  cachedArchiveBayRuntimeManifest ??= validateManifest(
    JSON.parse(fs.readFileSync(path.join(__dirname, "config", "archive-bay-runtimes.json"), "utf8")),
  );
  return cachedArchiveBayRuntimeManifest;
}

function currentArchiveBayPlatformKey() {
  return resolvePlatformKey({ platform: process.platform, arch: process.arch });
}

function sendManagedRuntimeProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("archive-bay:managed-runtime:progress", payload);
}

function archiveBayRecompErrorMessage(error) {
  // Coded-error-only, same rule as archiveBayRuntimeErrorMessage — the recomp
  // adapter's own errors and the download/zip errors it reuses are all coded;
  // never forward a raw path, URL, or Node error message to the renderer.
  return recompErrorCode(error);
}

function getArchiveBayRecompManifest() {
  cachedArchiveBayRecompManifest ??= validateRecompManifest(
    JSON.parse(fs.readFileSync(path.join(__dirname, "config", "archive-bay-recomp-ports.json"), "utf8")),
  );
  return cachedArchiveBayRecompManifest;
}

function sendRecompProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("archive-bay:recomp:progress", payload);
}

function registerIpc() {
  // A link that arrived before any renderer existed (cold start). Sender-gated
  // like every other channel, and cleared on read so it is delivered once.
  ipcMain.handle("axis-deep-link:consume-pending", (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS deep-link request");
    const pending = pendingDeepLink;
    pendingDeepLink = null;
    return pending;
  });

  ipcMain.handle("archive-bay:list", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const library = await getArchiveBayLibrary();
    return {
      titles: [...library.titles.values()].map(toPublicLegacyTitle),
      runtimeConfigured: Boolean(library.runtimePath),
      activeLaunch: activeArchiveBayLaunch ? { contentId: activeArchiveBayLaunch.contentId } : null,
    };
  });

  ipcMain.handle("archive-bay:import", async (event, input) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const picked = await showFilePicker({
      title: "Import a Nintendo DS ROM (.nds)",
      properties: ["openFile"],
      filters: [{ name: "Nintendo DS ROM", extensions: ["nds"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    try {
      const romPath = await canonicalizeImportPath(picked.filePaths[0]);
      const sha256 = await sha256File(romPath);
      const library = await getArchiveBayLibrary();
      // De-dupe by content hash, not path: the same ROM can be re-imported
      // from a different location without creating a second library entry.
      const existingEntry = [...library.titles.values()].find((title) => title.sha256 === sha256);
      if (existingEntry) return toPublicLegacyTitle(existingEntry);

      const contentId = randomUUID();
      const label = typeof input?.label === "string" && input.label.trim()
        ? input.label
        : path.basename(romPath, path.extname(romPath));
      const record = buildLegacyTitleRecord({
        contentId,
        label,
        runtimeKind: "external-emulator",
        sha256,
        addedAt: new Date().toISOString(),
      });
      library.titles.set(contentId, { ...record, romPath });
      await persistArchiveBayLibrary(library);
      return toPublicLegacyTitle(record);
    } catch (error) {
      observability.captureException(error, { operation: "archive-bay-import" });
      throw new Error(archiveBayErrorMessage(error));
    }
  });

  ipcMain.handle("archive-bay:remove", async (event, contentId) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const library = await getArchiveBayLibrary();
    if (!library.titles.delete(String(contentId))) return false;
    await persistArchiveBayLibrary(library);
    return true;
  });

  ipcMain.handle("archive-bay:runtime-status", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const library = await getArchiveBayLibrary();
    return { configured: Boolean(library.runtimePath) };
  });

  ipcMain.handle("archive-bay:runtime-choose", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const picked = await showFilePicker({
      title: "Choose your installed melonDS executable",
      properties: ["openFile"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { configured: false };
    try {
      const runtimePath = await canonicalizeRuntimePath(picked.filePaths[0]);
      const library = await getArchiveBayLibrary();
      library.runtimePath = runtimePath;
      await persistArchiveBayLibrary(library);
      return { configured: true };
    } catch (error) {
      observability.captureException(error, { operation: "archive-bay-runtime-choose" });
      throw new Error(archiveBayErrorMessage(error));
    }
  });

  ipcMain.handle("archive-bay:launch", async (event, contentId) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    const library = await getArchiveBayLibrary();
    const record = library.titles.get(String(contentId));
    if (!record) throw new Error("ARCHIVE_BAY_TITLE_NOT_FOUND");
    let spawnArgs;
    try {
      spawnArgs = buildLaunchSpawnArgs({ runtimePath: library.runtimePath, romPath: record.romPath });
    } catch (error) {
      throw new Error(archiveBayErrorMessage(error));
    }
    const child = spawn(spawnArgs.command, spawnArgs.args, spawnArgs.options);
    activeArchiveBayLaunch = { contentId: record.contentId, child };
    sendArchiveBayLaunchState({ contentId: record.contentId, status: "running" });
    child.on("error", (error) => {
      activeArchiveBayLaunch = null;
      observability.captureException(error, { operation: "archive-bay-launch" });
      sendArchiveBayLaunchState({
        contentId: record.contentId,
        status: "error",
        code: "ARCHIVE_BAY_LAUNCH_FAILED",
      });
    });
    child.on("exit", (code) => {
      activeArchiveBayLaunch = null;
      sendArchiveBayLaunchState({ contentId: record.contentId, status: "exited", exitCode: code });
    });
    return { contentId: record.contentId, status: "running" };
  });

  // Phase 16.2 — managed melonDS runtime. See ADR-0005 "OWNER LICENSING
  // DECISION ... Option B". Every handler is sender-gated exactly like the
  // 16.1 handlers above; none accepts a renderer-supplied URL, path, or
  // digest — the manifest (bundled in the asar, never renderer-suppliable)
  // is the sole source of those values.
  ipcMain.handle("archive-bay:managed-runtime:manifest", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    let manifest;
    try {
      manifest = getArchiveBayRuntimeManifest();
    } catch (error) {
      observability.captureException(error, { operation: "archive-bay-managed-runtime-manifest" });
      throw new Error(archiveBayRuntimeErrorMessage(error));
    }
    const base = {
      runtime: manifest.runtime,
      version: manifest.version,
      license: manifest.license,
      licenseUrl: manifest.licenseUrl,
      attribution: manifest.attribution,
      sourceUrl: manifest.correspondingSource.url,
    };
    try {
      const release = getPlatformRelease(manifest, currentArchiveBayPlatformKey());
      return { ...base, platformSupported: true, sizeBytes: release.sizeBytes };
    } catch (error) {
      if (error instanceof ArchiveBayRuntimeError && error.code === "RUNTIME_PLATFORM_UNSUPPORTED") {
        return { ...base, platformSupported: false, sizeBytes: null };
      }
      observability.captureException(error, { operation: "archive-bay-managed-runtime-manifest" });
      throw new Error(archiveBayRuntimeErrorMessage(error));
    }
  });

  ipcMain.handle("archive-bay:managed-runtime:status", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const state = await loadRuntimeState(archiveBayRuntimeStatePath).catch((error) => {
      observability.captureException(error, { operation: "archive-bay-managed-runtime-status" });
      return { installed: null };
    });
    return {
      installed: state.installed
        ? { version: state.installed.version, installedAt: state.installed.installedAt }
        : null,
      installing: managedRuntimeInstallInFlight,
    };
  });

  ipcMain.handle("archive-bay:managed-runtime:install", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (managedRuntimeInstallInFlight) throw new Error("RUNTIME_INSTALL_IN_PROGRESS");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    managedRuntimeInstallInFlight = true;
    sendManagedRuntimeProgress({ phase: "downloading", receivedBytes: 0, totalBytes: null });
    try {
      const manifest = getArchiveBayRuntimeManifest();
      const platformKey = currentArchiveBayPlatformKey();
      const licenseText = fs.readFileSync(path.join(__dirname, "config", "melonDS-LICENSE.txt"), "utf8");
      const executablePath = await installRuntime({
        manifest,
        platformKey,
        runtimesDir: archiveBayRuntimesDir,
        stateFilePath: archiveBayRuntimeStatePath,
        licenseText,
        onProgress: (progress) => sendManagedRuntimeProgress(progress),
      });
      const canonicalPath = await canonicalizeRuntimePath(executablePath);
      const library = await getArchiveBayLibrary();
      library.runtimePath = canonicalPath;
      await persistArchiveBayLibrary(library);
      sendManagedRuntimeProgress({ phase: "installed", version: manifest.version });
      return { installed: true, version: manifest.version };
    } catch (error) {
      const code = archiveBayRuntimeErrorMessage(error);
      observability.captureException(error, { operation: "archive-bay-managed-runtime-install" });
      sendManagedRuntimeProgress({ phase: "error", code });
      throw new Error(code);
    } finally {
      managedRuntimeInstallInFlight = false;
    }
  });

  ipcMain.handle("archive-bay:managed-runtime:remove", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (managedRuntimeInstallInFlight) throw new Error("RUNTIME_INSTALL_IN_PROGRESS");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    sendManagedRuntimeProgress({ phase: "removing" });
    try {
      const state = await loadRuntimeState(archiveBayRuntimeStatePath);
      const rawInstalledPath = resolveInstalledExecutablePath(archiveBayRuntimesDir, state.installed);
      const canonicalInstalledPath = rawInstalledPath
        ? await fsPromises.realpath(rawInstalledPath).catch(() => rawInstalledPath)
        : null;
      await removeRuntime({ runtimesDir: archiveBayRuntimesDir, stateFilePath: archiveBayRuntimeStatePath });
      if (canonicalInstalledPath) {
        const library = await getArchiveBayLibrary();
        if (library.runtimePath === canonicalInstalledPath) {
          library.runtimePath = null;
          await persistArchiveBayLibrary(library);
        }
      }
      sendManagedRuntimeProgress({ phase: "not-installed" });
      return { removed: true };
    } catch (error) {
      const code = archiveBayRuntimeErrorMessage(error);
      observability.captureException(error, { operation: "archive-bay-managed-runtime-remove" });
      sendManagedRuntimeProgress({ phase: "error", code });
      throw new Error(code);
    }
  });

  // Phase 16.3 — native-recompilation ports. See ADR-0005 (option 4, the
  // native-recomp LegacyRuntimeKind). Sender-gated exactly like the 16.1/16.2
  // handlers. AXIS downloads ONLY the port binary (pinned in the asar-bundled
  // manifest); the original the port needs is chosen by the user through a
  // native OS file dialog and validated by sha256 — never a renderer-supplied
  // path, URL, or digest.
  ipcMain.handle("archive-bay:recomp:manifest", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    let manifest;
    try {
      manifest = getArchiveBayRecompManifest();
    } catch (error) {
      observability.captureException(error, { operation: "archive-bay-recomp-manifest" });
      throw new Error(archiveBayRecompErrorMessage(error));
    }
    const platformKey = currentArchiveBayPlatformKey();
    return {
      ports: Object.values(manifest.ports).map((port) => {
        let platformSupported = true;
        let sizeBytes = null;
        try {
          sizeBytes = getRecompPortPlatformRelease(port, platformKey).sizeBytes;
        } catch {
          platformSupported = false;
        }
        return {
          id: port.id,
          name: port.name,
          version: port.version,
          homepageUrl: port.homepageUrl,
          license: port.license,
          licenseUrl: port.licenseUrl,
          attribution: port.attribution,
          sourceUrl: port.correspondingSource.url,
          // Only the human-facing parts of the original spec cross to the
          // renderer — the required sha256 stays main-side (it is the gate,
          // not a value the UI needs).
          requiredOriginal: {
            label: port.requiredOriginal.label,
            sizeBytes: port.requiredOriginal.sizeBytes,
            extensions: port.requiredOriginal.extensions,
          },
          platformSupported,
          sizeBytes,
        };
      }),
    };
  });

  ipcMain.handle("archive-bay:recomp:status", async (event) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    const state = await loadRecompState(archiveBayRecompStatePath).catch((error) => {
      observability.captureException(error, { operation: "archive-bay-recomp-status" });
      return { ports: {} };
    });
    const ports = {};
    for (const [portId, record] of Object.entries(state.ports)) {
      ports[portId] = {
        installed: true,
        version: record.version,
        installedAt: record.installedAt,
        // A port is only launchable once its user-supplied original is staged.
        originalReady: Boolean(record.original),
      };
    }
    return {
      ports,
      installing: recompInstallInFlight,
      activePortId: activeArchiveBayLaunch ? activeArchiveBayLaunch.contentId : null,
    };
  });

  ipcMain.handle("archive-bay:recomp:install", async (event, portId) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (recompInstallInFlight) throw new Error("RECOMP_INSTALL_IN_PROGRESS");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    recompInstallInFlight = true;
    sendRecompProgress({ portId: String(portId), phase: "downloading", receivedBytes: 0, totalBytes: null });
    try {
      const manifest = getArchiveBayRecompManifest();
      const port = getRecompPort(manifest, String(portId)); // RECOMP_PORT_UNKNOWN for an unknown id
      const platformKey = currentArchiveBayPlatformKey();
      await installRecompPort({
        manifest,
        portId: port.id,
        platformKey,
        portsDir: archiveBayRecompDir,
        stateFilePath: archiveBayRecompStatePath,
        onProgress: (progress) => sendRecompProgress({ portId: port.id, ...progress }),
      });
      sendRecompProgress({ portId: port.id, phase: "installed", version: port.version });
      return { installed: true, portId: port.id, version: port.version };
    } catch (error) {
      const code = archiveBayRecompErrorMessage(error);
      observability.captureException(error, { operation: "archive-bay-recomp-install" });
      sendRecompProgress({ portId: String(portId), phase: "error", code });
      throw new Error(code);
    } finally {
      recompInstallInFlight = false;
    }
  });

  ipcMain.handle("archive-bay:recomp:choose-original", async (event, portId) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (recompInstallInFlight) throw new Error("RECOMP_INSTALL_IN_PROGRESS");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    let manifest;
    let port;
    try {
      manifest = getArchiveBayRecompManifest();
      port = getRecompPort(manifest, String(portId));
    } catch (error) {
      throw new Error(archiveBayRecompErrorMessage(error));
    }
    const extensions = port.requiredOriginal.extensions.map((ext) => ext.replace(/^\./, "")).filter(Boolean);
    const picked = await showFilePicker({
      title: `Select your own copy of: ${port.requiredOriginal.label}`,
      properties: ["openFile"],
      filters: extensions.length ? [{ name: "Original game file", extensions }] : undefined,
    });
    if (picked.canceled || picked.filePaths.length === 0) return { staged: false, canceled: true };
    try {
      await validateAndStageOriginal({
        manifest,
        portId: port.id,
        portsDir: archiveBayRecompDir,
        stateFilePath: archiveBayRecompStatePath,
        originalFilePath: picked.filePaths[0],
      });
      return { staged: true, portId: port.id };
    } catch (error) {
      const code = archiveBayRecompErrorMessage(error);
      observability.captureException(error, { operation: "archive-bay-recomp-choose-original" });
      throw new Error(code);
    }
  });

  ipcMain.handle("archive-bay:recomp:remove", async (event, portId) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (recompInstallInFlight) throw new Error("RECOMP_INSTALL_IN_PROGRESS");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    try {
      await removeRecompPort({ portId: String(portId), portsDir: archiveBayRecompDir, stateFilePath: archiveBayRecompStatePath });
      return { removed: true };
    } catch (error) {
      const code = archiveBayRecompErrorMessage(error);
      observability.captureException(error, { operation: "archive-bay-recomp-remove" });
      throw new Error(code);
    }
  });

  ipcMain.handle("archive-bay:recomp:launch", async (event, portId) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS archive-bay request");
    if (activeArchiveBayLaunch) throw new Error("ARCHIVE_BAY_ALREADY_RUNNING");
    const state = await loadRecompState(archiveBayRecompStatePath);
    const installed = state.ports[String(portId)];
    let spec;
    try {
      // Throws RECOMP_NOT_INSTALLED / RECOMP_NOT_READY (no staged original) —
      // the readiness gate lives in the adapter, not here.
      spec = buildRecompLaunchSpec({ portsDir: archiveBayRecompDir, portId: String(portId), installed });
    } catch (error) {
      throw new Error(archiveBayRecompErrorMessage(error));
    }
    // The command lives entirely inside our own userData layout (never a
    // renderer- or manifest-suppliable absolute path), but re-canonicalize it
    // through the same realpath + file gate a BYO runtime goes through before
    // it is spawned — one trust gate, not two — and spawn with shell:false and
    // a fixed empty argument array.
    let command;
    try {
      command = await canonicalizeRuntimePath(spec.command);
    } catch (error) {
      throw new Error(archiveBayErrorMessage(error));
    }
    const child = spawn(command, spec.args, { shell: false, cwd: spec.cwd });
    activeArchiveBayLaunch = { contentId: String(portId), child };
    sendArchiveBayLaunchState({ contentId: String(portId), status: "running" });
    child.on("error", (error) => {
      activeArchiveBayLaunch = null;
      observability.captureException(error, { operation: "archive-bay-recomp-launch" });
      sendArchiveBayLaunchState({ contentId: String(portId), status: "error", code: "ARCHIVE_BAY_LAUNCH_FAILED" });
    });
    child.on("exit", (code) => {
      activeArchiveBayLaunch = null;
      sendArchiveBayLaunchState({ contentId: String(portId), status: "exited", exitCode: code });
    });
    return { portId: String(portId), status: "running" };
  });

  ipcMain.handle("axis-browser:open", (event, input) => {
    if (!isTrustedAxisSender(event)) throw new Error("Untrusted AXIS browser request");
    return createBrowserWindow(input?.url, input?.title);
  });
  ipcMain.handle("axis-browser:back", (event) => {
    const record = recordFor(event);
    if (record?.view.webContents.navigationHistory.canGoBack()) record.view.webContents.navigationHistory.goBack();
  });
  ipcMain.handle("axis-browser:forward", (event) => {
    const record = recordFor(event);
    if (record?.view.webContents.navigationHistory.canGoForward()) record.view.webContents.navigationHistory.goForward();
  });
  ipcMain.handle("axis-browser:reload", (event) => recordFor(event)?.view.webContents.reload());
  ipcMain.handle("axis-browser:stop", (event) => recordFor(event)?.view.webContents.stop());
  ipcMain.handle("axis-browser:navigate", (event, url) => {
    const record = recordFor(event);
    if (record) return record.view.webContents.loadURL(normalizeWebUrl(url));
  });
  ipcMain.handle("axis-browser:external", (event) => {
    const url = recordFor(event)?.view.webContents.getURL();
    if (url) return shell.openExternal(normalizeWebUrl(url));
  });
  ipcMain.handle("axis-browser:capabilities", async (event) => {
    const record = recordFor(event);
    if (!record) throw new Error("Untrusted browser capabilities request");
    await showBrowserCapabilities(record);
    return true;
  });
  ipcMain.handle("axis-browser:reader", async (event) => {
    const record = recordFor(event);
    const url = record?.view.webContents.getURL();
    if (!record || !url) return;

    try {
      const response = await session.defaultSession.fetch(
        `${axisOrigin}/api/reader/extract?url=${encodeURIComponent(url)}`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error(`Reader unavailable (${response.status})`);
      const article = await response.json();
      const articleId = randomUUID();
      readerArticles.set(articleId, article);
      const readerWindow = new BrowserWindow({
        parent: mainWindow || undefined,
        width: 900,
        height: 820,
        title: article.title || "Reader",
        icon: appIconPath,
        webPreferences: {
          preload: path.join(__dirname, "reader-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      // The reader renders sanitized third-party HTML into a window that holds
      // a preload. It must therefore stay pinned to the local reader resource:
      // any navigation away, and any popup, leaves for the isolated browser or
      // the system browser instead of loading remote content into this origin.
      readerWindow.webContents.on("will-navigate", (event, nextUrl) => {
        if (nextUrl === readerFileUrl || nextUrl.startsWith(`${readerFileUrl}?`)) return;
        event.preventDefault();
        void openSafeExternal(nextUrl);
      });
      readerWindow.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
        void openSafeExternal(nextUrl);
        return { action: "deny" };
      });

      readerWindow.on("closed", () => readerArticles.delete(articleId));
      await readerWindow.loadFile(path.join(__dirname, "reader.html"), { query: { article: articleId } });
    } catch (error) {
      observability.captureException(error, {
        hostname: hostnameFor(url),
        operation: "reader-view",
      });
      throw error;
    }
  });
  ipcMain.handle("axis-reader:get", (event, articleId) => {
    if (event.senderFrame.url.split("?")[0] !== readerFileUrl) {
      throw new Error("Untrusted reader request");
    }
    const article = readerArticles.get(String(articleId));
    if (!article) throw new Error("Reader article expired");
    readerArticles.delete(String(articleId));
    return article;
  });
}

async function waitForAxis() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(axisUrl, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`AXIS did not start at ${axisUrl}`);
}

function openSafeExternal(rawUrl) {
  try {
    return shell.openExternal(normalizeWebUrl(rawUrl));
  } catch (error) {
    observability.captureException(error, { operation: "open-external" });
    return Promise.resolve();
  }
}

async function createMainWindow() {
  if (startsDevServer && !devServer) {
    devServer = spawn("npm", ["run", "dev", "--", "--hostname", "127.0.0.1"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit",
      shell: false,
    });
    await waitForAxis();
  }

  // Held locally as well as in the module reference: every listener below must
  // act on the window it was registered for, never on whichever window happens
  // to be current when the listener fires.
  const window = new BrowserWindow({
    title: "AXIS",
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0d11",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "axis-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  window.webContents.on("will-navigate", (event, nextUrl) => {
    try {
      if (new URL(nextUrl).origin !== axisOrigin) {
        event.preventDefault();
        void openSafeExternal(nextUrl);
      }
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Same-origin popups are AXIS's own OAuth return leg and must open INSIDE
    // the app. Denying them and shelling out to the system browser broke every
    // provider connect: window.open() returned null, openOAuthPopup fell back to
    // navigating the main window, and the grant completed in a browser whose
    // cookie jar the app cannot read — so tokens never reached AXIS and the
    // connect button appeared to do nothing.
    //
    // An allowed popup inherits this window's session (the isolated in-app
    // browser uses the separate persist:axis-browser partition), so the Supabase
    // session and the OAuth state cookie are both present, and window.opener
    // survives for the /oauth-done postMessage handshake.
    try {
      if (new URL(url).origin === axisOrigin) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 480,
            height: 700,
            autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
            },
          },
        };
      }
    } catch {
      // Unparseable URL — fall through and treat as external.
    }
    void openSafeExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("did-fail-load", (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    observability.captureException(new Error(`AXIS origin failed to load (${errorCode})`), {
      hostname: hostnameFor(validatedUrl),
      operation: "axis-load",
    });
    // A load in flight when the window goes away fails on the way out, so this
    // handler can run during teardown. The common teardown code (ERR_ABORTED,
    // -3) is filtered above, but the others are not, and a dialog raised then
    // is unanswerable — attached to a dying window it blocks the quit outright.
    // The single-flight flag additionally stops an offline origin from stacking
    // a fresh sheet on every Retry.
    if (isQuitting || !liveWindow(window) || loadErrorDialogOpen) return;
    loadErrorDialogOpen = true;
    void showDialog({
      type: "error",
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
      title: "AXIS could not connect",
      message: "The desktop app could not reach AXIS.",
      detail: `${hostnameFor(axisUrl)} may be unavailable, or this device may be offline.`,
    }, { owner: window }).then(({ response }) => {
      loadErrorDialogOpen = false;
      if (response === 0) void liveWindow(window)?.loadURL(axisUrl).catch(() => {
        // The next did-fail-load reports it; a rejected retry is not a fault.
      });
      else if (response === 1) app.quit();
    });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    observability.captureMessage("AXIS renderer process stopped", {
      exitCode: details.exitCode,
      operation: "axis-renderer",
      reason: details.reason,
    });
  });
  window.on("closed", () => {
    // Only clear the shared reference if it still points at THIS window. A
    // replacement window (dock activate after a close) must not be
    // un-referenced by its predecessor's teardown, which would leave a live
    // window that deep links and Archive Bay both believe is gone.
    if (mainWindow === window) mainWindow = null;
  });
  // A failed first load is already surfaced by did-fail-load above. Letting it
  // reject here instead aborts the rest of app.whenReady() and leaves an
  // unhandled rejection behind.
  await window.loadURL(axisUrl).catch((error) => {
    observability.captureException(error, { operation: "axis-load-initial" });
  });
  if (process.env.AXIS_DESKTOP_SMOKE_URL) {
    createBrowserWindow(process.env.AXIS_DESKTOP_SMOKE_URL, "AXIS Browser Smoke Test");
    console.log(`AXIS desktop browser smoke window opened: ${hostnameFor(process.env.AXIS_DESKTOP_SMOKE_URL)}`);
  }
}

/**
 * createMainWindow() is not synchronous in --dev: it awaits the dev server
 * before constructing anything, so two overlapping calls (a second dock
 * activate, or activate racing startup) would each build a window and the
 * loser would be orphaned — visible, unreferenced, and unclosable from the app.
 */
function ensureMainWindow() {
  if (liveWindow(mainWindow)) return Promise.resolve(mainWindow);
  mainWindowPromise ??= createMainWindow().finally(() => {
    mainWindowPromise = null;
  });
  return mainWindowPromise;
}

async function runCrashReporterSmoke() {
  if (process.env.AXIS_DESKTOP_CRASH_SMOKE !== "renderer") return;
  if (!observability.uploadsEnabled) throw new Error("Crash smoke requires an embedded desktop Sentry DSN");

  const reportKey = (report) => `${report.id}:${new Date(report.date).getTime()}`;
  const uploadedBefore = new Set(crashReporter.getUploadedReports().map(reportKey));
  const crashWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await crashWindow.loadURL("about:blank");
  crashWindow.webContents.forcefullyCrashRenderer();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const uploaded = crashReporter.getUploadedReports()
      .find((report) => !uploadedBefore.has(reportKey(report)));
    if (uploaded) {
      console.log(
        `AXIS desktop native crash upload verified: ${uploaded.id || new Date(uploaded.date).toISOString()}`,
      );
      if (!crashWindow.isDestroyed()) crashWindow.destroy();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!crashWindow.isDestroyed()) crashWindow.destroy();
  throw new Error("Crashpad did not confirm a native crash upload within 45 seconds");
}

function installApplicationMenu() {
  const updateItem = {
    label: "Check for Updates…",
    // On macOS this menu item is reachable with zero windows open, and the
    // update prompts refuse to open ownerless (update-controller.cjs) — so
    // visible feedback needs a live window first. Ensuring one is also just
    // the right response to the user reaching for the app.
    click: () => {
      void ensureMainWindow()
        .catch(() => null)
        .then(() => updateController?.checkForUpdates({ interactive: true }));
    },
  };
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        updateItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : [{
      label: "File",
      submenu: [updateItem, { type: "separator" }, { role: "quit" }],
    }]),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  observability.captureMessage("Electron child process stopped", {
    exitCode: details.exitCode,
    operation: "child-process",
    reason: details.reason,
    type: details.type,
  });
});

app.whenReady().then(async () => {
  // Register axis:// before the first window exists so a cold-start link is
  // attributable to this build.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("axis");
  } else if (process.argv[1]) {
    app.setAsDefaultProtocolClient("axis", process.execPath, [path.resolve(process.argv[1])]);
  }
  if (process.platform === "darwin" && app.dock && !nativeImage.createFromPath(appIconPath).isEmpty()) {
    app.dock.setIcon(appIconPath);
  }
  await configureBrowserSession();
  registerIpc();
  updateController = createUpdateController({
    app,
    autoUpdater: loadAutoUpdater(),
    dialog,
    getMainWindow: () => liveWindow(mainWindow),
    observability,
    isQuitting: () => isQuitting,
  });
  installApplicationMenu();
  await ensureMainWindow();
  await runCrashReporterSmoke();
}).catch((error) => {
  // Without this the whole startup chain fails as an unhandled rejection: no
  // window, no report, and a process that lingers with nothing on screen.
  observability.captureException(error, { operation: "app-startup" });
  console.error("AXIS desktop failed to start:", error);
});

// ── axis:// deep links ───────────────────────────────────────────────────────
// Everything below routes through parseDeepLink, which allowlists a small set
// of internal routes and refuses to carry credentials. A link that does not
// parse is ignored — never navigated to, never logged in full (an OS-supplied
// string may contain anything).

let pendingDeepLink = null;

function deliverDeepLink(raw) {
  const parsed = parseDeepLink(raw);
  if (!parsed) {
    observability.captureMessage("Ignored an unrecognised deep link", {
      operation: "deep-link",
    });
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("axis-deep-link", parsed);
    pendingDeepLink = null;
    return;
  }
  // Cold start: no renderer yet. Hold it for consumePending().
  pendingDeepLink = parsed;
}

app.on("second-instance", (_event, argv) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const link = findDeepLinkInArgv(argv);
  if (link) deliverDeepLink(link);
});

// macOS delivers links via open-url rather than argv, on both cold and warm start.
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverDeepLink(url);
});

app.on("before-quit", () => {
  // Latched before any window closes so the teardown-time dialog suppression
  // in showDialog() is already in force by the time did-fail-load fires.
  isQuitting = true;
  updateController?.dispose();
  if (devServer) devServer.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (isQuitting) return;
  void ensureMainWindow().catch((error) => {
    observability.captureException(error, { operation: "app-activate" });
  });
});
