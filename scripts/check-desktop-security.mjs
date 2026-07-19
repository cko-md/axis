import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "electron/build/icon.icns",
  "electron/build/icon.ico",
  "electron/build/icon.png",
  "electron/build/icons/512x512.png",
  "electron/browser-capabilities.cjs",
  "electron/desktop-observability.cjs",
  "electron/electron-builder.cjs",
  "electron/update-controller.cjs",
];

await Promise.all(requiredFiles.map((file) => access(path.join(root, file))));

const packageJson = JSON.parse(await readFile(path.join(root, "electron/package.json"), "utf8"));
const mainSource = await readFile(path.join(root, "electron/main.cjs"), "utf8");
const trustedPreloadSource = await readFile(path.join(root, "electron/axis-preload.cjs"), "utf8");
const builderSource = await readFile(path.join(root, "electron/electron-builder.cjs"), "utf8");
// desktop-release.yml is deliberately deferred until signing secrets exist
// (see docs/desktop-distribution.md). Its invariant checks run only when the
// workflow is present; everything else below always runs.
const releaseWorkflowSource = await readFile(
  path.join(root, ".github/workflows/desktop-release.yml"),
  "utf8",
).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
  return null;
});
async function sourceFilesIn(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") return [];
      return sourceFilesIn(relative);
    }
    return /\.(?:[cm]?js|jsx|ts|tsx)$/.test(entry.name) ? [relative] : [];
  }));
  return nested.flat();
}

const sourceFiles = [
  ...(await sourceFilesIn("src")),
  ...(await sourceFilesIn("electron")),
];

if (!packageJson.axisDesktop?.productionUrl?.startsWith("https://")) {
  throw new Error("Packaged AXIS desktop origin must be an explicit HTTPS URL");
}
if (packageJson.dependencies?.["electron-updater"] !== "6.8.9") {
  throw new Error("electron-updater must remain an exact runtime dependency");
}
for (const invariant of [
  "contextIsolation: true",
  "nodeIntegration: false",
  "sandbox: true",
  "webSecurity: true",
  'partition: "persist:axis-browser"',
  // Exactly one main process owns the updater, the single mainWindow, and
  // Archive Bay's install/remove concurrency guards.
  "requestSingleInstanceLock",
  "second-instance",
  // axis:// links are registered and must go through the allowlisting parser
  // rather than being navigated to directly.
  "setAsDefaultProtocolClient",
  "parseDeepLink",
  // The hosted origin runs in defaultSession, which previously had no
  // permission policy at all and inherited Chromium's permissive defaults.
  "configureDefaultSessionPermissions",
  "setPermissionRequestHandler",
  // Downloads must be filename-sanitised and never auto-opened.
  "will-download",
  "attachDownloadPolicy",
]) {
  if (!mainSource.includes(invariant)) throw new Error(`Missing Electron security invariant: ${invariant}`);
}

// The reader renders sanitized third-party HTML in a window that holds a
// preload, so it must stay pinned to the local reader resource.
const readerLockdown = mainSource.slice(mainSource.indexOf("readerWindow = new BrowserWindow"));
for (const invariant of ["will-navigate", "setWindowOpenHandler"]) {
  if (!readerLockdown.includes(invariant)) {
    throw new Error(`Reader window is missing a navigation lockdown invariant: ${invariant}`);
  }
}
for (const invariant of [
  "forceCodeSigning",
  "hardenedRuntime: isRelease",
  "notarize: isRelease",
  "azureSignOptions",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  // Package-time fuses. Each of the first three is a documented way to turn an
  // Electron binary into an arbitrary Node runtime; the ASAR pair makes a
  // swapped source file fail to load rather than execute.
  "electronFuses",
  "runAsNode: false",
  "enableNodeOptionsEnvironmentVariable: false",
  "enableNodeCliInspectArguments: false",
  "enableEmbeddedAsarIntegrityValidation: true",
  "onlyLoadAppFromAsar: true",
  "enableCookieEncryption: true",
  "grantFileProtocolExtraPrivileges: false",
]) {
  if (!builderSource.includes(invariant)) throw new Error(`Missing release invariant: ${invariant}`);
}
if (releaseWorkflowSource === null) {
  console.log("desktop-release.yml not present yet; skipping signed-release workflow invariant checks.");
} else {
  for (const invariant of [
    "Verify Windows Authenticode signatures",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_CERT_PROFILE",
  ]) {
    if (!releaseWorkflowSource.includes(invariant)) {
      throw new Error(`Missing Windows signing workflow invariant: ${invariant}`);
    }
  }
}
for (const invariant of [".wv-overlay", "/api/proxy", "axis-sidebar", 'hasAttribute("aria-expanded")']) {
  if (!trustedPreloadSource.includes(invariant)) {
    throw new Error(`Missing hosted rollout compatibility invariant: ${invariant}`);
  }
}

for (const file of sourceFiles) {
  const source = await readFile(path.join(root, file), "utf8");
  const sandboxAttributes = source.match(/sandbox\s*=\s*["'`][^"'`]+["'`]/gs) || [];
  if (sandboxAttributes.some((value) => value.includes("allow-scripts") && value.includes("allow-same-origin"))) {
    throw new Error(`Unsafe iframe sandbox combination found in ${file}`);
  }
}

try {
  await access(path.join(root, "src/components/layout/ExternalWindow.tsx"));
  throw new Error("Legacy ExternalWindow iframe must not be restored");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

console.log("Desktop origin, release, icon, updater, and sandbox security invariants are present.");
