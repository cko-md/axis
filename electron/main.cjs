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
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  compatibilityForUrl,
  createManagedExtensionManager,
} = require("./browser-capabilities.cjs");
const { createDesktopObservability } = require("./desktop-observability.cjs");
const { resolveRuntimeConfig } = require("./runtime-config.cjs");
const { createUpdateController } = require("./update-controller.cjs");

app.enableSandbox();

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
let devServer = null;
let mainWindow = null;
let updateController = null;
let extensionManager = null;

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
  const result = await dialog.showMessageBox({
    type: "info",
    buttons: ["Open extension folder", "Reload extensions", "Open page externally", "Close"],
    defaultId: 3,
    cancelId: 3,
    title: "AXIS Browser capabilities",
    message: "Browser compatibility and privacy",
    detail,
  });

  if (result.response === 0) {
    await extensionManager?.openFolder();
  } else if (result.response === 1) {
    const next = await extensionManager?.reload();
    sendBrowserState(record);
    await dialog.showMessageBox({
      type: next?.failed.length ? "warning" : "info",
      title: "Browser extensions reloaded",
      message: `${next?.loaded.length || 0} extension(s) loaded.`,
      detail: next?.failed.length
        ? `${next.failed.length} extension(s) failed. Open the extension folder and review enabled.json.`
        : "Only explicitly enabled unpacked extensions are active.",
    });
  } else if (result.response === 2) {
    const url = record.view.webContents.getURL();
    if (url) await shell.openExternal(normalizeWebUrl(url));
  }
}

function createBrowserWindow(rawUrl, requestedTitle) {
  const url = normalizeWebUrl(rawUrl);
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

  window.on("closed", () => {
    browserWindows.delete(toolbar.webContents.id);
    browserViewIds.delete(view.webContents.id);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (!toolbar.webContents.isDestroyed()) toolbar.webContents.close();
  });

  void view.webContents.loadURL(url);
  return true;
}

function recordFor(event) {
  return browserWindows.get(event.sender.id);
}

async function configureBrowserSession() {
  const browserSession = session.fromPartition("persist:axis-browser");
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
    void dialog.showMessageBox({
      type: "question",
      buttons: ["Allow once", "Block"],
      defaultId: 1,
      cancelId: 1,
      title: "Website permission",
      message: `Allow ${hostname} to use ${permission}?`,
      detail: "The permission applies only to this request in the isolated AXIS browser session.",
    }).then(({ response }) => callback(response === 0));
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

function registerIpc() {
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

  mainWindow = new BrowserWindow({
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
  mainWindow.webContents.on("will-navigate", (event, nextUrl) => {
    try {
      if (new URL(nextUrl).origin !== axisOrigin) {
        event.preventDefault();
        void openSafeExternal(nextUrl);
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openSafeExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    observability.captureException(new Error(`AXIS origin failed to load (${errorCode})`), {
      hostname: hostnameFor(validatedUrl),
      operation: "axis-load",
    });
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
      title: "AXIS could not connect",
      message: "The desktop app could not reach AXIS.",
      detail: `${hostnameFor(axisUrl)} may be unavailable, or this device may be offline.`,
    }).then(({ response }) => {
      if (response === 0) void mainWindow?.loadURL(axisUrl);
      else app.quit();
    });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    observability.captureMessage("AXIS renderer process stopped", {
      exitCode: details.exitCode,
      operation: "axis-renderer",
      reason: details.reason,
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(axisUrl);
  if (process.env.AXIS_DESKTOP_SMOKE_URL) {
    createBrowserWindow(process.env.AXIS_DESKTOP_SMOKE_URL, "AXIS Browser Smoke Test");
    console.log(`AXIS desktop browser smoke window opened: ${hostnameFor(process.env.AXIS_DESKTOP_SMOKE_URL)}`);
  }
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
    click: () => updateController?.checkForUpdates({ interactive: true }),
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
  if (process.platform === "darwin" && app.dock && !nativeImage.createFromPath(appIconPath).isEmpty()) {
    app.dock.setIcon(appIconPath);
  }
  await configureBrowserSession();
  registerIpc();
  updateController = createUpdateController({
    app,
    autoUpdater,
    dialog,
    getMainWindow: () => mainWindow,
    observability,
  });
  installApplicationMenu();
  await createMainWindow();
  await runCrashReporterSmoke();
});

app.on("before-quit", () => {
  updateController?.dispose();
  if (devServer) devServer.kill("SIGTERM");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) void createMainWindow();
});
