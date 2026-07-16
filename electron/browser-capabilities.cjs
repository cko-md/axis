/* eslint-disable @typescript-eslint/no-require-imports */
const { mkdir, lstat, readFile, realpath, writeFile } = require("node:fs/promises");
const path = require("node:path");

const EXTENSION_POLICY_FILE = "enabled.json";
const EXTENSION_README_FILE = "README.txt";
const MAX_MANAGED_EXTENSIONS = 24;
const SAFE_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const BLOCKED_EXTENSION_PERMISSIONS = new Set([
  "debugger",
  "nativeMessaging",
  "proxy",
  "vpnProvider",
]);
const DRM_HOSTS = [
  "netflix.com",
  "disneyplus.com",
  "hulu.com",
  "max.com",
  "peacocktv.com",
  "paramountplus.com",
  "primevideo.com",
  "tv.apple.com",
  "open.spotify.com",
];

const EXTENSION_README = `AXIS managed browser extensions

Electron supports only a subset of Chrome extension APIs. AXIS loads explicitly
enabled unpacked extensions from this directory; Chrome Web Store .crx installs
are not supported.

1. Create one child directory per unpacked extension.
2. Add the directory name to enabled.json:
   { "version": 1, "enabled": ["my-extension"] }
3. In AXIS Browser, open Browser capabilities and choose Reload extensions.

Extensions can read or change browsing data according to their manifest. Enable
only code you trust. AXIS rejects symlinks and extensions requesting debugger,
nativeMessaging, proxy, or vpnProvider permissions.
`;

function matchesHost(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function compatibilityForUrl(rawUrl, { passwordForm = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (matchesHost(url.hostname, "chromewebstore.google.com") ||
      matchesHost(url.hostname, "chrome.google.com") && url.pathname.startsWith("/webstore")) {
    return {
      key: "extension-store",
      message: "Chrome Web Store installs are unavailable. AXIS can load explicitly enabled unpacked extensions; use ◫ for details.",
    };
  }

  if (DRM_HOSTS.some((domain) => matchesHost(url.hostname, domain))) {
    return {
      key: "proprietary-drm",
      message: "This service commonly requires Widevine or another proprietary DRM module. Use ↗ to continue in your system browser.",
    };
  }

  if (passwordForm) {
    return {
      key: "password-manager",
      message: "AXIS does not capture or autofill website passwords. Use ↗ for Chrome, Edge, or your installed password manager.",
    };
  }

  return null;
}

function parseExtensionPolicy(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.enabled)) {
    throw new Error("enabled.json must contain { \"version\": 1, \"enabled\": [] }");
  }
  if (parsed.enabled.length > MAX_MANAGED_EXTENSIONS) {
    throw new Error(`At most ${MAX_MANAGED_EXTENSIONS} managed extensions may be enabled`);
  }

  const unique = [];
  const seen = new Set();
  for (const value of parsed.enabled) {
    const name = String(value || "").trim();
    if (!SAFE_DIRECTORY_NAME.test(name) || name === "." || name === "..") {
      throw new Error(`Invalid extension directory name: ${name || "(empty)"}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(name);
    }
  }
  return unique;
}

function validateExtensionManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest.json must contain an object");
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) {
    throw new Error("Only Manifest V2 or V3 unpacked extensions are supported");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("Extension manifest requires a name");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Extension manifest requires a version");
  }

  const permissions = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ].filter((permission) => typeof permission === "string");
  const blocked = permissions.filter((permission) => BLOCKED_EXTENSION_PERMISSIONS.has(permission));
  if (blocked.length) {
    throw new Error(`Unsupported high-risk extension permissions: ${blocked.join(", ")}`);
  }

  const hostPermissions = [
    ...permissions,
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
  ];
  return {
    name: manifest.name.trim().slice(0, 120),
    version: manifest.version.trim().slice(0, 40),
    broadHostAccess: hostPermissions.includes("<all_urls>"),
  };
}

function safeState(state) {
  return {
    directory: state.directory,
    loaded: state.loaded.map((extension) => ({ ...extension })),
    failed: state.failed.map((extension) => ({ ...extension })),
  };
}

function createManagedExtensionManager({ app, browserSession, shell }) {
  const directory = path.join(app.getPath("userData"), "browser-extensions");
  const policyPath = path.join(directory, EXTENSION_POLICY_FILE);
  const loadedIds = new Set();
  let state = { directory, loaded: [], failed: [] };

  async function ensureFiles() {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, EXTENSION_README_FILE), EXTENSION_README, { flag: "wx" })
      .catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
    await writeFile(policyPath, '{\n  "version": 1,\n  "enabled": []\n}\n', { flag: "wx" })
      .catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
  }

  async function resolveExtensionDirectory(name) {
    const candidate = path.join(directory, name);
    const stats = await lstat(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Extension entry must be a real directory, not a symlink");
    }
    const [rootPath, candidatePath] = await Promise.all([realpath(directory), realpath(candidate)]);
    if (!candidatePath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error("Extension directory escapes the managed root");
    }
    return candidatePath;
  }

  async function reload() {
    await ensureFiles();
    for (const extensionId of loadedIds) {
      try {
        browserSession.extensions.removeExtension(extensionId);
      } catch {
        // The extension may already have unloaded itself.
      }
    }
    loadedIds.clear();
    state = { directory, loaded: [], failed: [] };

    let enabled;
    try {
      enabled = parseExtensionPolicy(await readFile(policyPath, "utf8"));
    } catch (error) {
      state.failed.push({
        directory: EXTENSION_POLICY_FILE,
        reason: error instanceof Error ? error.message : "Extension policy could not be read",
      });
      return safeState(state);
    }

    for (const entry of enabled) {
      try {
        const extensionDirectory = await resolveExtensionDirectory(entry);
        const manifest = validateExtensionManifest(
          JSON.parse(await readFile(path.join(extensionDirectory, "manifest.json"), "utf8")),
        );
        const extension = await browserSession.extensions.loadExtension(extensionDirectory, {
          allowFileAccess: false,
        });
        loadedIds.add(extension.id);
        state.loaded.push({
          directory: entry,
          id: extension.id,
          name: manifest.name,
          version: manifest.version,
          broadHostAccess: manifest.broadHostAccess,
        });
      } catch (error) {
        state.failed.push({
          directory: entry,
          reason: error instanceof Error ? error.message.slice(0, 180) : "Extension could not be loaded",
        });
      }
    }

    return safeState(state);
  }

  return {
    async initialize() {
      return reload();
    },
    async reload() {
      return reload();
    },
    getState() {
      return safeState(state);
    },
    async openFolder() {
      await ensureFiles();
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
      return true;
    },
  };
}

module.exports = {
  compatibilityForUrl,
  createManagedExtensionManager,
  parseExtensionPolicy,
  validateExtensionManifest,
};
