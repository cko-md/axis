/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const zlib = require("node:zlib");
const {
  ArchiveBayRuntimeError,
  assertSafeRelativePath,
  buildAttributionText,
  downloadAndVerify,
  emptyRuntimeState,
  extractZipBuffer,
  getPlatformRelease,
  installRuntime,
  loadRuntimeState,
  parseRuntimeState,
  parseZipEntries,
  removeRuntime,
  resolveInstalledExecutablePath,
  resolvePlatformKey,
  saveRuntimeState,
  validateManifest,
  validateZipEntryPath,
} = require("./archive-bay-runtime.cjs");

const VALID_SHA256 = "a".repeat(64);

function validPlatformRelease(overrides = {}) {
  return {
    url: "https://github.com/melonDS-emu/melonDS/releases/download/1.1/melonDS-1.1-macOS-universal.zip",
    sha256: VALID_SHA256,
    sizeBytes: 1024,
    archiveFormat: "zip",
    executableRelativePath: "melonDS.app/Contents/MacOS/melonDS",
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    runtime: "melonDS",
    version: "1.1",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/melonDS-emu/melonDS/blob/master/LICENSE",
    attribution: "melonDS is an independent GPL-3.0 project.",
    correspondingSource: {
      url: "https://github.com/melonDS-emu/melonDS/archive/refs/tags/1.1.tar.gz",
      sha256: VALID_SHA256,
      sourceTag: "1.1",
      sourceCommit: "b86390e4428bf38ce4c1ce0e9ca446d6d25955e8",
    },
    platforms: {
      "darwin-arm64": validPlatformRelease(),
      "darwin-x64": validPlatformRelease(),
      "win32-x64": validPlatformRelease({ executableRelativePath: "melonDS.exe" }),
      "linux-x64": validPlatformRelease({ executableRelativePath: "melonDS" }),
    },
    ...overrides,
  };
}

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-archive-bay-runtime-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

test("validateManifest accepts a well-formed manifest and normalizes sha256 casing", () => {
  const manifest = validateManifest(validManifest({
    correspondingSource: {
      url: "https://example.test/source.tar.gz",
      sha256: VALID_SHA256.toUpperCase(),
      sourceTag: "1.1",
      sourceCommit: "abc123",
    },
  }));
  assert.equal(manifest.version, "1.1");
  assert.equal(manifest.license, "GPL-3.0");
  assert.equal(manifest.correspondingSource.sha256, VALID_SHA256);
  assert.equal(Object.keys(manifest.platforms).length, 4);
});

test("validateManifest rejects a non-object, wrong schema version, or missing runtime name", () => {
  assert.throws(() => validateManifest(null), (e) => e.code === "RUNTIME_MANIFEST_INVALID");
  assert.throws(() => validateManifest("nope"), (e) => e.code === "RUNTIME_MANIFEST_INVALID");
  assert.throws(
    () => validateManifest(validManifest({ schemaVersion: 2 })),
    (e) => e.code === "RUNTIME_MANIFEST_SCHEMA_MISMATCH",
  );
  assert.throws(
    () => validateManifest(validManifest({ runtime: "" })),
    (e) => e.code === "RUNTIME_MANIFEST_INVALID",
  );
});

test("validateManifest requires exactly GPL-3.0 as the declared license", () => {
  assert.throws(
    () => validateManifest(validManifest({ license: "MIT" })),
    (e) => e.code === "RUNTIME_MANIFEST_LICENSE_INVALID",
  );
});

test("validateManifest rejects a non-https license URL or corresponding-source URL", () => {
  assert.throws(
    () => validateManifest(validManifest({ licenseUrl: "http://example.test/LICENSE" })),
    (e) => e.code === "RUNTIME_MANIFEST_LICENSE_URL_INVALID",
  );
  assert.throws(
    () => validateManifest(validManifest({
      correspondingSource: { url: "http://example.test/src.tar.gz", sha256: VALID_SHA256 },
    })),
    (e) => e.code === "RUNTIME_MANIFEST_SOURCE_INVALID",
  );
});

test("validateManifest rejects missing/empty attribution text", () => {
  assert.throws(
    () => validateManifest(validManifest({ attribution: "   " })),
    (e) => e.code === "RUNTIME_MANIFEST_ATTRIBUTION_INVALID",
  );
});

test("validateManifest rejects an empty platforms object", () => {
  assert.throws(
    () => validateManifest(validManifest({ platforms: {} })),
    (e) => e.code === "RUNTIME_MANIFEST_PLATFORMS_INVALID",
  );
});

test("validateManifest rejects a platform release with a non-https download URL", () => {
  assert.throws(
    () => validateManifest(validManifest({
      platforms: { "darwin-arm64": validPlatformRelease({ url: "http://example.test/melonDS.zip" }) },
    })),
    (e) => e.code === "RUNTIME_MANIFEST_URL_INVALID",
  );
});

test("validateManifest rejects a malformed sha256", () => {
  assert.throws(
    () => validateManifest(validManifest({
      platforms: { "darwin-arm64": validPlatformRelease({ sha256: "not-hex" }) },
    })),
    (e) => e.code === "RUNTIME_MANIFEST_SHA256_INVALID",
  );
});

test("validateManifest rejects a non-positive or non-integer sizeBytes", () => {
  for (const sizeBytes of [0, -1, 1.5, "1024"]) {
    assert.throws(
      () => validateManifest(validManifest({ platforms: { "darwin-arm64": validPlatformRelease({ sizeBytes }) } })),
      (e) => e.code === "RUNTIME_MANIFEST_SIZE_INVALID",
    );
  }
});

test("validateManifest rejects an archive format other than zip", () => {
  assert.throws(
    () => validateManifest(validManifest({
      platforms: { "darwin-arm64": validPlatformRelease({ archiveFormat: "tar.gz" }) },
    })),
    (e) => e.code === "RUNTIME_MANIFEST_FORMAT_UNSUPPORTED",
  );
});

test("validateManifest rejects a traversal-shaped executableRelativePath even inside the manifest itself", () => {
  assert.throws(
    () => validateManifest(validManifest({
      platforms: { "darwin-arm64": validPlatformRelease({ executableRelativePath: "../../etc/passwd" }) },
    })),
    (e) => e.code === "RUNTIME_MANIFEST_EXECUTABLE_PATH_INVALID",
  );
  assert.throws(
    () => validateManifest(validManifest({
      platforms: { "darwin-arm64": validPlatformRelease({ executableRelativePath: "/etc/passwd" }) },
    })),
    (e) => e.code === "RUNTIME_MANIFEST_EXECUTABLE_PATH_INVALID",
  );
});

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

test("resolvePlatformKey composes platform-arch and getPlatformRelease looks it up", () => {
  const manifest = validateManifest(validManifest());
  assert.equal(resolvePlatformKey({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  const release = getPlatformRelease(manifest, resolvePlatformKey({ platform: "darwin", arch: "arm64" }));
  assert.equal(release.executableRelativePath, "melonDS.app/Contents/MacOS/melonDS");
});

test("getPlatformRelease throws a coded error for an unsupported platform/arch combination", () => {
  const manifest = validateManifest(validManifest());
  assert.throws(
    () => getPlatformRelease(manifest, resolvePlatformKey({ platform: "linux", arch: "arm64" })),
    (e) => e.code === "RUNTIME_PLATFORM_UNSUPPORTED",
  );
  assert.throws(
    () => getPlatformRelease(manifest, resolvePlatformKey({ platform: "freebsd", arch: "x64" })),
    (e) => e.code === "RUNTIME_PLATFORM_UNSUPPORTED",
  );
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test("assertSafeRelativePath accepts ordinary relative paths and rejects traversal/absolute/drive-letter paths", () => {
  assert.equal(assertSafeRelativePath("melonDS.exe", "X"), "melonDS.exe");
  assert.equal(assertSafeRelativePath("a/b/c.txt", "X"), "a/b/c.txt");
  for (const bad of ["../evil", "a/../../b", "/etc/passwd", "C:\\evil.exe", "a\0b", ""]) {
    assert.throws(() => assertSafeRelativePath(bad, "X_CODE"), (e) => e.code === "X_CODE", `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("validateZipEntryPath resolves a safe entry inside destDir and rejects escape attempts", async () => {
  await withTempDir(async (dir) => {
    const target = validateZipEntryPath("melonDS.app/Contents/MacOS/melonDS", dir);
    assert.equal(target, path.join(dir, "melonDS.app/Contents/MacOS/melonDS"));
    for (const bad of ["../escape.txt", "/etc/passwd", "a/../../escape.txt"]) {
      assert.throws(() => validateZipEntryPath(bad, dir), (e) => e.code === "RUNTIME_ZIP_ENTRY_UNSAFE");
    }
  });
});

// ---------------------------------------------------------------------------
// Minimal ZIP builder used only by these tests (store + deflate methods).
// ---------------------------------------------------------------------------

function buildZipBuffer(entries) {
  const localParts = [];
  const localOffsets = [];
  let offset = 0;
  for (const entry of entries) {
    const isDir = entry.data === undefined;
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const rawData = isDir ? Buffer.alloc(0) : entry.data;
    const method = !isDir && entry.deflate ? 8 : 0;
    const compressedData = method === 8 ? zlib.deflateRawSync(rawData) : rawData;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localOffsets.push(offset);
    localParts.push(localHeader, nameBuffer, compressedData);
    offset += localHeader.length + nameBuffer.length + compressedData.length;
  }
  const localBuffer = Buffer.concat(localParts);
  const startOfCentral = offset;

  const centralParts = [];
  entries.forEach((entry, index) => {
    const isDir = entry.data === undefined;
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const rawData = isDir ? Buffer.alloc(0) : entry.data;
    const method = !isDir && entry.deflate ? 8 : 0;
    const compressedData = method === 8 ? zlib.deflateRawSync(rawData) : rawData;
    const mode = entry.mode ?? (isDir ? 0o40755 : 0o100644);
    const externalAttrs = (mode << 16) >>> 0;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressedData.length, 20);
    central.writeUInt32LE(rawData.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(localOffsets[index], 42);
    centralParts.push(central, nameBuffer);
  });
  const centralBuffer = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(startOfCentral, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

// ---------------------------------------------------------------------------
// ZIP parsing and extraction
// ---------------------------------------------------------------------------

test("parseZipEntries reads directory and file entries with correct sizes and unix modes", () => {
  const zip = buildZipBuffer([
    { name: "melonDS.app/", mode: 0o40755 },
    { name: "melonDS.app/melonDS", data: Buffer.from("binary-bytes"), mode: 0o100755 },
    { name: "melonDS.app/readme.txt", data: Buffer.from("hello world, ".repeat(50)), deflate: true, mode: 0o100644 },
  ]);
  const entries = parseZipEntries(zip);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].isDirectory, true);
  assert.equal(entries[1].isDirectory, false);
  assert.equal(entries[1].compressionMethod, 0);
  assert.equal(entries[1].unixMode & 0o777, 0o755);
  assert.equal(entries[2].compressionMethod, 8);
  assert.equal(entries[2].unixMode & 0o777, 0o644);
});

test("extractZipBuffer writes files byte-for-byte, preserves directory structure, and chmods the declared executable", async () => {
  await withTempDir(async (dir) => {
    const binaryBytes = Buffer.from("fake-melonds-binary-bytes");
    const readmeText = "hello world, ".repeat(50);
    const zip = buildZipBuffer([
      { name: "melonDS.app/", mode: 0o40755 },
      { name: "melonDS.app/Contents/MacOS/", mode: 0o40755 },
      { name: "melonDS.app/Contents/MacOS/melonDS", data: binaryBytes, mode: 0o100644 },
      { name: "melonDS.app/readme.txt", data: Buffer.from(readmeText), deflate: true, mode: 0o100644 },
    ]);
    const destDir = path.join(dir, "extracted");
    await extractZipBuffer(zip, destDir, { executableRelativePath: "melonDS.app/Contents/MacOS/melonDS" });

    const extractedBinary = await fs.readFile(path.join(destDir, "melonDS.app/Contents/MacOS/melonDS"));
    assert.deepEqual(extractedBinary, binaryBytes);
    const extractedReadme = await fs.readFile(path.join(destDir, "melonDS.app/readme.txt"), "utf8");
    assert.equal(extractedReadme, readmeText);

    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(destDir, "melonDS.app/Contents/MacOS/melonDS"));
      // 0o100644 was declared in the archive, but the executable is force-chmod'd 0o755.
      assert.equal(stat.mode & 0o777, 0o755);
    }
  });
});

test("extractZipBuffer rejects a traversal entry and writes nothing outside destDir", async () => {
  await withTempDir(async (dir) => {
    const zip = buildZipBuffer([
      { name: "melonDS.exe", data: Buffer.from("safe") },
      { name: "../escape.txt", data: Buffer.from("malicious") },
    ]);
    const destDir = path.join(dir, "extracted");
    await assert.rejects(
      () => extractZipBuffer(zip, destDir, {}),
      (e) => e instanceof ArchiveBayRuntimeError && e.code === "RUNTIME_ZIP_ENTRY_UNSAFE",
    );
    const escapedPath = path.join(dir, "escape.txt");
    await assert.rejects(() => fs.access(escapedPath));
  });
});

test("extractZipBuffer rejects an absolute-path entry", async () => {
  await withTempDir(async (dir) => {
    const zip = buildZipBuffer([{ name: "/tmp/escape.txt", data: Buffer.from("malicious") }]);
    await assert.rejects(
      () => extractZipBuffer(zip, path.join(dir, "extracted"), {}),
      (e) => e.code === "RUNTIME_ZIP_ENTRY_UNSAFE",
    );
  });
});

test("extractZipBuffer throws a coded error if the declared executable is missing from the archive", async () => {
  await withTempDir(async (dir) => {
    const zip = buildZipBuffer([{ name: "readme.txt", data: Buffer.from("no binary here") }]);
    await assert.rejects(
      () => extractZipBuffer(zip, path.join(dir, "extracted"), { executableRelativePath: "melonDS.exe" }),
      (e) => e.code === "RUNTIME_EXECUTABLE_MISSING_AFTER_EXTRACT",
    );
  });
});

// ---------------------------------------------------------------------------
// Download + verify (fake transport, no real network)
// ---------------------------------------------------------------------------

function fakeTransport({ statusCode = 200, headers = {}, chunks = [], errorAfterHeaders = null }) {
  return {
    get(_url, callback) {
      const response = new PassThrough();
      response.statusCode = statusCode;
      response.headers = headers;
      queueMicrotask(() => {
        callback(response);
        if (errorAfterHeaders) {
          response.emit("error", errorAfterHeaders);
          return;
        }
        for (const chunk of chunks) response.write(chunk);
        response.end();
      });
      const request = new PassThrough();
      return request;
    },
  };
}

test("downloadAndVerify rejects a non-https URL before any request is made", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => downloadAndVerify("http://example.test/melonDS.zip", path.join(dir, "out.zip"), {
        transport: fakeTransport({}),
      }),
      (e) => e.code === "RUNTIME_INSECURE_URL",
    );
  });
});

test("downloadAndVerify follows an https redirect and verifies the final payload", async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.from("melonDS-fake-release-bytes");
    const sha256 = require("node:crypto").createHash("sha256").update(payload).digest("hex");
    let call = 0;
    const transport = {
      get(_url, callback) {
        call += 1;
        const response = new PassThrough();
        if (call === 1) {
          response.statusCode = 302;
          response.headers = { location: "https://example.test/redirected.zip" };
          queueMicrotask(() => {
            callback(response);
            response.end();
          });
        } else {
          response.statusCode = 200;
          response.headers = {};
          queueMicrotask(() => {
            callback(response);
            response.write(payload);
            response.end();
          });
        }
        return new PassThrough();
      },
    };
    const destPath = path.join(dir, "out.zip");
    const result = await downloadAndVerify("https://example.test/first.zip", destPath, {
      expectedSha256: sha256,
      expectedSizeBytes: payload.length,
      transport,
    });
    assert.equal(result.sha256, sha256);
    assert.deepEqual(await fs.readFile(destPath), payload);
    assert.equal(call, 2);
  });
});

test("downloadAndVerify deletes the temp file and throws on a digest mismatch", async () => {
  await withTempDir(async (dir) => {
    const destPath = path.join(dir, "out.zip");
    await assert.rejects(
      () => downloadAndVerify("https://example.test/first.zip", destPath, {
        expectedSha256: "b".repeat(64),
        transport: fakeTransport({ chunks: [Buffer.from("some bytes")] }),
      }),
      (e) => e.code === "RUNTIME_DIGEST_MISMATCH",
    );
    await assert.rejects(() => fs.access(destPath));
    await assert.rejects(() => fs.access(`${destPath}.download`));
  });
});

test("downloadAndVerify detects a truncated (short) download against the declared size", async () => {
  await withTempDir(async (dir) => {
    const destPath = path.join(dir, "out.zip");
    await assert.rejects(
      () => downloadAndVerify("https://example.test/first.zip", destPath, {
        expectedSizeBytes: 999999,
        transport: fakeTransport({ chunks: [Buffer.from("too short")] }),
      }),
      (e) => e.code === "RUNTIME_DOWNLOAD_INCOMPLETE",
    );
    await assert.rejects(() => fs.access(destPath));
  });
});

test("downloadAndVerify surfaces a coded error for a non-200, non-redirect response", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => downloadAndVerify("https://example.test/missing.zip", path.join(dir, "out.zip"), {
        transport: fakeTransport({ statusCode: 404 }),
      }),
      (e) => e.code === "RUNTIME_DOWNLOAD_HTTP_ERROR",
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime install-state persistence
// ---------------------------------------------------------------------------

test("loadRuntimeState returns an empty state when the file does not exist", async () => {
  await withTempDir(async (dir) => {
    const state = await loadRuntimeState(path.join(dir, "does-not-exist", "state.json"));
    assert.deepEqual(state, emptyRuntimeState());
  });
});

test("saveRuntimeState / loadRuntimeState round-trip an installed record", async () => {
  await withTempDir(async (dir) => {
    const stateFilePath = path.join(dir, "state.json");
    const installed = {
      version: "1.1",
      platformKey: "darwin-arm64",
      sha256: VALID_SHA256,
      executableRelativePath: "melonDS.app/Contents/MacOS/melonDS",
      installedAt: new Date().toISOString(),
    };
    await saveRuntimeState(stateFilePath, { schemaVersion: 1, installed });
    const reloaded = await loadRuntimeState(stateFilePath);
    assert.deepEqual(reloaded.installed, installed);
  });
});

test("parseRuntimeState rejects corrupt or malformed state files", () => {
  assert.throws(() => parseRuntimeState("not json"), (e) => e.code === "RUNTIME_STATE_CORRUPT");
  assert.throws(
    () => parseRuntimeState(JSON.stringify({ schemaVersion: 2, installed: null })),
    (e) => e.code === "RUNTIME_STATE_CORRUPT",
  );
  assert.throws(
    () => parseRuntimeState(JSON.stringify({ schemaVersion: 1, installed: { version: "1.1" } })),
    (e) => e.code === "RUNTIME_STATE_CORRUPT",
  );
});

test("resolveInstalledExecutablePath composes the versioned directory with the recorded relative path", () => {
  const installed = {
    version: "1.1",
    platformKey: "darwin-arm64",
    sha256: VALID_SHA256,
    executableRelativePath: "melonDS.app/Contents/MacOS/melonDS",
    installedAt: new Date().toISOString(),
  };
  const resolved = resolveInstalledExecutablePath("/userData/archive-bay/runtimes", installed);
  assert.equal(resolved, path.join("/userData/archive-bay/runtimes", "1.1", "darwin-arm64", "melonDS.app/Contents/MacOS/melonDS"));
  assert.equal(resolveInstalledExecutablePath("/userData/archive-bay/runtimes", null), null);
});

// ---------------------------------------------------------------------------
// Full install / remove orchestration
// ---------------------------------------------------------------------------

test("installRuntime downloads, verifies, extracts, writes compliance artifacts, and records state; removeRuntime cleans up", async () => {
  await withTempDir(async (dir) => {
    const manifest = validateManifest(validManifest());
    const platformKey = "linux-x64";
    const binaryBytes = Buffer.from("fake-melonds-linux-binary");
    const zip = buildZipBuffer([{ name: "melonDS", data: binaryBytes, mode: 0o100755 }]);
    const crypto = require("node:crypto");
    const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
    manifest.platforms[platformKey] = {
      url: "https://example.test/melonDS-linux.zip",
      sha256,
      sizeBytes: zip.length,
      archiveFormat: "zip",
      executableRelativePath: "melonDS",
    };

    const runtimesDir = path.join(dir, "runtimes");
    const stateFilePath = path.join(runtimesDir, "state.json");
    const progressEvents = [];

    const executablePath = await installRuntime({
      manifest,
      platformKey,
      runtimesDir,
      stateFilePath,
      licenseText: "GPL-3.0 FULL TEXT PLACEHOLDER",
      onProgress: (event) => progressEvents.push(event),
      transport: fakeTransport({ chunks: [zip] }),
    });

    assert.deepEqual(await fs.readFile(executablePath), binaryBytes);
    assert.equal(await fs.readFile(path.join(path.dirname(executablePath), "LICENSE"), "utf8"), "GPL-3.0 FULL TEXT PLACEHOLDER");
    const attribution = await fs.readFile(path.join(path.dirname(executablePath), "ATTRIBUTION.txt"), "utf8");
    assert.match(attribution, /melonDS/);
    assert.match(attribution, /GPL-3\.0/);
    assert.match(attribution, /archive\/refs\/tags\/1\.1\.tar\.gz/);

    const state = await loadRuntimeState(stateFilePath);
    assert.equal(state.installed.version, "1.1");
    assert.equal(state.installed.platformKey, platformKey);
    assert.equal(state.installed.sha256, sha256);

    assert.ok(progressEvents.some((event) => event.phase === "downloading"));
    assert.ok(progressEvents.some((event) => event.phase === "verifying"));
    assert.ok(progressEvents.some((event) => event.phase === "extracting"));

    await removeRuntime({ runtimesDir, stateFilePath });
    const stateAfterRemove = await loadRuntimeState(stateFilePath);
    assert.equal(stateAfterRemove.installed, null);
    await assert.rejects(() => fs.access(executablePath));
  });
});

test("installRuntime deletes the download and throws before extraction on a digest mismatch", async () => {
  await withTempDir(async (dir) => {
    const manifest = validateManifest(validManifest());
    const platformKey = "linux-x64";
    manifest.platforms[platformKey] = {
      url: "https://example.test/melonDS-linux.zip",
      sha256: "c".repeat(64),
      sizeBytes: 4,
      archiveFormat: "zip",
      executableRelativePath: "melonDS",
    };
    const runtimesDir = path.join(dir, "runtimes");
    await assert.rejects(
      () => installRuntime({
        manifest,
        platformKey,
        runtimesDir,
        stateFilePath: path.join(runtimesDir, "state.json"),
        transport: fakeTransport({ chunks: [Buffer.from("nope")] }),
      }),
      (e) => e.code === "RUNTIME_DIGEST_MISMATCH",
    );
    const state = await loadRuntimeState(path.join(runtimesDir, "state.json"));
    assert.equal(state.installed, null);
  });
});

test("buildAttributionText includes version, license, source URL, and an unmodified-distribution note", () => {
  const manifest = validateManifest(validManifest());
  const text = buildAttributionText(manifest);
  assert.match(text, /melonDS 1\.1/);
  assert.match(text, /GPL-3\.0/);
  assert.match(text, /archive\/refs\/tags\/1\.1\.tar\.gz/);
  assert.match(text, /unmodified/);
});
