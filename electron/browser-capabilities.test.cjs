/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compatibilityForUrl,
  createManagedExtensionManager,
  parseExtensionPolicy,
  validateExtensionManifest,
} = require("./browser-capabilities.cjs");

test("browser compatibility identifies DRM, extension-store, and password-manager handoffs", () => {
  assert.equal(compatibilityForUrl("https://www.netflix.com/watch/1").key, "proprietary-drm");
  assert.equal(
    compatibilityForUrl("https://chromewebstore.google.com/detail/example").key,
    "extension-store",
  );
  assert.equal(
    compatibilityForUrl("https://example.com/login", { passwordForm: true }).key,
    "password-manager",
  );
  assert.equal(compatibilityForUrl("https://example.com/"), null);
});

test("extension policy blocks traversal and caps enabled entries", () => {
  assert.deepEqual(
    parseExtensionPolicy('{"version":1,"enabled":["reader","reader","dark-mode"]}'),
    ["reader", "dark-mode"],
  );
  assert.throws(
    () => parseExtensionPolicy('{"version":1,"enabled":["../outside"]}'),
    /Invalid extension directory name/,
  );
});

test("extension manifest rejects unsupported high-risk capabilities", () => {
  assert.deepEqual(
    validateExtensionManifest({
      manifest_version: 3,
      name: "AXIS test",
      version: "1.0.0",
      host_permissions: ["<all_urls>"],
    }),
    {
      name: "AXIS test",
      version: "1.0.0",
      broadHostAccess: true,
    },
  );
  assert.throws(
    () => validateExtensionManifest({
      manifest_version: 3,
      name: "Native bridge",
      version: "1.0.0",
      permissions: ["nativeMessaging"],
    }),
    /nativeMessaging/,
  );
});

test("managed extension loader requires explicit policy enablement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "axis-extensions-"));
  const loaded = [];
  const removed = [];
  const browserSession = {
    extensions: {
      async loadExtension(extensionPath) {
        loaded.push(extensionPath);
        return { id: "extension-id" };
      },
      removeExtension(extensionId) {
        removed.push(extensionId);
      },
    },
  };
  const manager = createManagedExtensionManager({
    app: { getPath: () => root },
    browserSession,
    shell: { openPath: async () => "" },
  });

  try {
    const initial = await manager.initialize();
    assert.equal(initial.loaded.length, 0);
    const extensionRoot = path.join(root, "browser-extensions");
    assert.match(await readFile(path.join(extensionRoot, "README.txt"), "utf8"), /explicitly\s+enabled/);

    await mkdir(path.join(extensionRoot, "reader"));
    await writeFile(
      path.join(extensionRoot, "reader", "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Reader", version: "1.0.0" }),
    );
    await writeFile(
      path.join(extensionRoot, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["reader"] }),
    );

    const next = await manager.reload();
    assert.equal(next.loaded[0].name, "Reader");
    assert.equal(loaded.length, 1);
    await manager.reload();
    assert.deepEqual(removed, ["extension-id"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
