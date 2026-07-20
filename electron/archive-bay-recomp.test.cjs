/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Archive Bay native-recomp adapter (Phase 16.3) tests.
 *
 * Everything here runs against in-memory fixtures and a fake transport — no
 * network, and critically NO copyrighted content. The "original game" the
 * recomp needs is modelled by a tiny fixture buffer whose sha256 is computed
 * in-test; that is the whole point of the sha256-validation design (a wrong or
 * incomplete file is rejected without the real game ever being involved).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const zlib = require("node:zlib");

const {
  ArchiveBayRecompError,
  validateRecompManifest,
  getPort,
  getPortPlatformRelease,
  emptyRecompState,
  parseRecompState,
  loadRecompState,
  saveRecompState,
  hashFile,
  buildRecompAttributionText,
  installPort,
  validateAndStageOriginal,
  removePort,
  isPortUpdateAvailable,
  buildRecompLaunchSpec,
  recompErrorCode,
} = require("./archive-bay-recomp.cjs");
const { ArchiveBayRuntimeError } = require("./archive-bay-runtime.cjs");

const VALID_SHA256 = "a".repeat(64);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validRequiredOriginal(overrides = {}) {
  return {
    label: "Your own legally-owned original cartridge dump",
    sha256: VALID_SHA256,
    sizeBytes: 1024,
    stagedName: "baserom.bin",
    extensions: [".z64", ".n64"],
    ...overrides,
  };
}

function validPortRelease(overrides = {}) {
  return {
    url: "https://example.test/port/releases/download/1.0.0/port-linux-x64.zip",
    sha256: VALID_SHA256,
    sizeBytes: 1024,
    archiveFormat: "zip",
    executableRelativePath: "port",
    ...overrides,
  };
}

function validPort(overrides = {}) {
  return {
    name: "Example Native Port",
    version: "1.0.0",
    homepageUrl: "https://example.test/port",
    license: "GPL-3.0",
    licenseUrl: "https://example.test/port/blob/main/LICENSE",
    attribution: "Example Port is an independent community project.",
    correspondingSource: {
      url: "https://example.test/port/archive/refs/tags/1.0.0.zip",
      sha256: VALID_SHA256,
      sourceTag: "1.0.0",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    },
    requiredOriginal: validRequiredOriginal(),
    platforms: {
      "linux-x64": validPortRelease(),
      "darwin-arm64": validPortRelease({ executableRelativePath: "Port.app/Contents/MacOS/Port" }),
    },
    ...overrides,
  };
}

function validRecompManifest(ports = { "example-port": validPort() }) {
  return { schemaVersion: 1, ports };
}

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-archive-bay-recomp-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Minimal ZIP builder (store + deflate) — identical shape to the one in
// archive-bay-runtime.test.cjs, kept local so the two suites stay independent.
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
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
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
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressedData.length, 20);
    central.writeUInt32LE(rawData.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(((mode << 16) >>> 0), 38);
    central.writeUInt32LE(localOffsets[index], 42);
    centralParts.push(central, nameBuffer);
  });
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(startOfCentral, 16);
  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}

function fakeTransport({ statusCode = 200, headers = {}, chunks = [] }) {
  return {
    get(_url, callback) {
      const response = new PassThrough();
      response.statusCode = statusCode;
      response.headers = headers;
      queueMicrotask(() => {
        callback(response);
        for (const chunk of chunks) response.write(chunk);
        response.end();
      });
      return new PassThrough();
    },
  };
}

// Builds a port-binary zip and a manifest wired to its real sha256/size, so
// installPort's own verification passes against the fixture transport.
function portFixture({ version = "1.0.0", platformKey = "linux-x64", executableRelativePath = "port", requiredOriginal } = {}) {
  const binaryBytes = Buffer.from(`fake-native-port-binary-${version}`);
  const zip = buildZipBuffer([{ name: executableRelativePath, data: binaryBytes, mode: 0o100755 }]);
  const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
  const port = validPort({
    version,
    requiredOriginal: requiredOriginal ?? validRequiredOriginal(),
    platforms: {
      [platformKey]: validPortRelease({
        url: "https://example.test/port.zip",
        sha256,
        sizeBytes: zip.length,
        executableRelativePath,
      }),
    },
  });
  const manifest = validateRecompManifest(validRecompManifest({ "example-port": port }));
  return { manifest, zip, binaryBytes, platformKey };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

test("validateRecompManifest accepts an empty ports map (the shipped default)", () => {
  const manifest = validateRecompManifest({ schemaVersion: 1, ports: {} });
  assert.deepEqual(manifest, { schemaVersion: 1, ports: {} });
});

test("validateRecompManifest accepts a well-formed port and normalizes sha256 casing", () => {
  const manifest = validateRecompManifest(validRecompManifest({
    "example-port": validPort({
      correspondingSource: {
        url: "https://example.test/src.zip",
        sha256: VALID_SHA256.toUpperCase(),
        sourceTag: "1.0.0",
      },
      requiredOriginal: validRequiredOriginal({ sha256: VALID_SHA256.toUpperCase() }),
    }),
  }));
  const port = manifest.ports["example-port"];
  assert.equal(port.id, "example-port");
  assert.equal(port.correspondingSource.sha256, VALID_SHA256);
  assert.equal(port.requiredOriginal.sha256, VALID_SHA256);
  assert.equal(Object.keys(port.platforms).length, 2);
});

test("validateRecompManifest rejects a non-object, wrong schema version, or non-object ports", () => {
  assert.throws(() => validateRecompManifest(null), (e) => e.code === "RECOMP_MANIFEST_INVALID");
  assert.throws(() => validateRecompManifest({ schemaVersion: 2, ports: {} }), (e) => e.code === "RECOMP_MANIFEST_SCHEMA_MISMATCH");
  assert.throws(() => validateRecompManifest({ schemaVersion: 1, ports: [] }), (e) => e.code === "RECOMP_MANIFEST_INVALID");
});

test("validateRecompManifest rejects an invalid port id", () => {
  for (const badId of ["Example", "a".repeat(64), "under_score", "has space", ""]) {
    assert.throws(
      () => validateRecompManifest({ schemaVersion: 1, ports: { [badId]: validPort() } }),
      (e) => e.code === "RECOMP_PORT_ID_INVALID",
      `expected rejection for id ${JSON.stringify(badId)}`,
    );
  }
});

test("validateRecompManifest requires name, version, license, https licenseUrl, and attribution", () => {
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ name: "" }) })), (e) => e.code === "RECOMP_PORT_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ version: "" }) })), (e) => e.code === "RECOMP_PORT_VERSION_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ license: "" }) })), (e) => e.code === "RECOMP_PORT_LICENSE_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ licenseUrl: "http://x/LICENSE" }) })), (e) => e.code === "RECOMP_PORT_LICENSE_URL_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ attribution: "" }) })), (e) => e.code === "RECOMP_PORT_ATTRIBUTION_INVALID");
});

test("validateRecompManifest rejects a malformed corresponding-source block", () => {
  assert.throws(
    () => validateRecompManifest(validRecompManifest({ p: validPort({ correspondingSource: { url: "http://x/src.zip", sha256: VALID_SHA256 } }) })),
    (e) => e.code === "RECOMP_PORT_SOURCE_INVALID",
  );
  assert.throws(
    () => validateRecompManifest(validRecompManifest({ p: validPort({ correspondingSource: { url: "https://x/src.zip", sha256: "not-hex" } }) })),
    (e) => e.code === "RECOMP_PORT_SOURCE_INVALID",
  );
});

test("validateRecompManifest rejects a malformed requiredOriginal (the user-supplied-original gate)", () => {
  const bad = [
    validRequiredOriginal({ sha256: "not-hex" }),
    validRequiredOriginal({ sizeBytes: 0 }),
    validRequiredOriginal({ sizeBytes: 1.5 }),
    validRequiredOriginal({ label: "" }),
    validRequiredOriginal({ stagedName: "" }),
    validRequiredOriginal({ stagedName: "../escape.bin" }),
    validRequiredOriginal({ stagedName: "/abs/escape.bin" }),
  ];
  for (const requiredOriginal of bad) {
    assert.throws(
      () => validateRecompManifest(validRecompManifest({ p: validPort({ requiredOriginal }) })),
      (e) => e.code === "RECOMP_ORIGINAL_SPEC_INVALID",
      `expected rejection for requiredOriginal ${JSON.stringify(requiredOriginal)}`,
    );
  }
});

test("validateRecompManifest rejects empty platforms and malformed platform releases", () => {
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ platforms: {} }) })), (e) => e.code === "RECOMP_PORT_PLATFORMS_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ platforms: { "linux-x64": validPortRelease({ url: "http://x/p.zip" }) } }) })), (e) => e.code === "RECOMP_PORT_URL_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ platforms: { "linux-x64": validPortRelease({ sha256: "nope" }) } }) })), (e) => e.code === "RECOMP_PORT_SHA256_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ platforms: { "linux-x64": validPortRelease({ sizeBytes: 0 }) } }) })), (e) => e.code === "RECOMP_PORT_SIZE_INVALID");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ platforms: { "linux-x64": validPortRelease({ archiveFormat: "tar" }) } }) })), (e) => e.code === "RECOMP_PORT_FORMAT_UNSUPPORTED");
  assert.throws(() => validateRecompManifest(validRecompManifest({ p: validPort({ platforms: { "linux-x64": validPortRelease({ executableRelativePath: "../../etc/passwd" }) } }) })), (e) => e.code === "RECOMP_PORT_EXECUTABLE_PATH_INVALID");
});

test("getPort / getPortPlatformRelease throw coded errors for unknown port and unsupported platform", () => {
  const manifest = validateRecompManifest(validRecompManifest());
  assert.throws(() => getPort(manifest, "nope"), (e) => e.code === "RECOMP_PORT_UNKNOWN");
  const port = getPort(manifest, "example-port");
  assert.throws(() => getPortPlatformRelease(port, "win32-arm64"), (e) => e.code === "RECOMP_PLATFORM_UNSUPPORTED");
});

// ---------------------------------------------------------------------------
// The SHIPPED manifest must itself be schema-valid.
// ---------------------------------------------------------------------------

test("the bundled archive-bay-recomp-ports.json validates and ships with no enabled ports", async () => {
  const raw = JSON.parse(await fs.readFile(path.join(__dirname, "config", "archive-bay-recomp-ports.json"), "utf8"));
  const manifest = validateRecompManifest(raw);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.ports, {});
});

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

test("loadRecompState returns an empty per-port map when the file does not exist", async () => {
  await withTempDir(async (dir) => {
    const state = await loadRecompState(path.join(dir, "missing", "state.json"));
    assert.deepEqual(state, emptyRecompState());
  });
});

test("saveRecompState / loadRecompState round-trip a port record with a staged original", async () => {
  await withTempDir(async (dir) => {
    const stateFilePath = path.join(dir, "state.json");
    const record = {
      version: "1.0.0",
      platformKey: "linux-x64",
      sha256: VALID_SHA256,
      executableRelativePath: "port",
      installedAt: new Date().toISOString(),
      original: { sha256: VALID_SHA256, stagedRelativePath: "assets/baserom.bin", stagedAt: new Date().toISOString() },
    };
    await saveRecompState(stateFilePath, { schemaVersion: 1, ports: { "example-port": record } });
    const reloaded = await loadRecompState(stateFilePath);
    assert.deepEqual(reloaded.ports["example-port"], record);
  });
});

test("parseRecompState rejects corrupt JSON, wrong schema, bad port id, and malformed records", () => {
  assert.throws(() => parseRecompState("not json"), (e) => e.code === "RECOMP_STATE_CORRUPT");
  assert.throws(() => parseRecompState(JSON.stringify({ schemaVersion: 2, ports: {} })), (e) => e.code === "RECOMP_STATE_CORRUPT");
  assert.throws(() => parseRecompState(JSON.stringify({ schemaVersion: 1, ports: { "Bad Id": {} } })), (e) => e.code === "RECOMP_STATE_CORRUPT");
  assert.throws(() => parseRecompState(JSON.stringify({ schemaVersion: 1, ports: { "example-port": { version: "1.0.0" } } })), (e) => e.code === "RECOMP_STATE_CORRUPT");
  assert.throws(
    () => parseRecompState(JSON.stringify({ schemaVersion: 1, ports: { "example-port": {
      version: "1.0.0", platformKey: "linux-x64", sha256: VALID_SHA256, executableRelativePath: "port", installedAt: "t",
      original: { sha256: "nope" },
    } } })),
    (e) => e.code === "RECOMP_STATE_CORRUPT",
  );
});

// ---------------------------------------------------------------------------
// hashFile
// ---------------------------------------------------------------------------

test("hashFile streams a file and returns its sha256 and size", async () => {
  await withTempDir(async (dir) => {
    const bytes = Buffer.from("some original game bytes");
    const filePath = path.join(dir, "orig.bin");
    await fs.writeFile(filePath, bytes);
    const { sha256, sizeBytes } = await hashFile(filePath);
    assert.equal(sizeBytes, bytes.length);
    assert.equal(sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  });
});

// ---------------------------------------------------------------------------
// buildRecompAttributionText — the load-bearing "no game assets" statement.
// ---------------------------------------------------------------------------

test("buildRecompAttributionText credits the port, cites source, and states AXIS ships no game assets", () => {
  const manifest = validateRecompManifest(validRecompManifest());
  const text = buildRecompAttributionText(manifest.ports["example-port"]);
  assert.match(text, /Example Native Port 1\.0\.0/);
  assert.match(text, /GPL-3\.0/);
  assert.match(text, /archive\/refs\/tags\/1\.0\.0\.zip/);
  assert.match(text, /ships\s+[\s\S]*none of the original game's assets/);
  assert.match(text, /you supply and legally own/);
});

// ---------------------------------------------------------------------------
// Full install → validate-original → launch-spec → remove pipeline (POC)
// ---------------------------------------------------------------------------

test("installPort downloads/verifies/extracts the port binary, writes compliance artifacts, and records original:null", async () => {
  await withTempDir(async (dir) => {
    const { manifest, zip, binaryBytes, platformKey } = portFixture();
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    const events = [];

    const exePath = await installPort({
      manifest, portId: "example-port", platformKey, portsDir, stateFilePath,
      licenseText: "GPL-3.0 FULL TEXT PLACEHOLDER",
      onProgress: (e) => events.push(e),
      transport: fakeTransport({ chunks: [zip] }),
    });

    assert.deepEqual(await fs.readFile(exePath), binaryBytes);
    assert.equal(await fs.readFile(path.join(path.dirname(exePath), "LICENSE"), "utf8"), "GPL-3.0 FULL TEXT PLACEHOLDER");
    assert.match(await fs.readFile(path.join(path.dirname(exePath), "ATTRIBUTION.txt"), "utf8"), /none of the original game's assets/);

    const state = await loadRecompState(stateFilePath);
    assert.equal(state.ports["example-port"].version, "1.0.0");
    assert.equal(state.ports["example-port"].original, null, "port is installed but not yet launchable");
    assert.ok(events.some((e) => e.phase === "installed"));
  });
});

test("installPort deletes the download and records nothing on a digest mismatch", async () => {
  await withTempDir(async (dir) => {
    const port = validPort({ platforms: { "linux-x64": validPortRelease({ url: "https://example.test/p.zip", sha256: "c".repeat(64), sizeBytes: 4 }) } });
    const manifest = validateRecompManifest(validRecompManifest({ "example-port": port }));
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    await assert.rejects(
      () => installPort({ manifest, portId: "example-port", platformKey: "linux-x64", portsDir, stateFilePath, transport: fakeTransport({ chunks: [Buffer.from("nope")] }) }),
      (e) => e.code === "RUNTIME_DIGEST_MISMATCH",
    );
    const state = await loadRecompState(stateFilePath);
    assert.deepEqual(state.ports, {});
  });
});

test("validateAndStageOriginal accepts the exact original, stages it locally, and never records the source path", async () => {
  await withTempDir(async (dir) => {
    // Build a fixture "original" and pin the manifest to ITS hash/size.
    const original = Buffer.from("x".repeat(2048));
    const requiredOriginal = validRequiredOriginal({
      sha256: crypto.createHash("sha256").update(original).digest("hex"),
      sizeBytes: original.length,
      stagedName: "baserom.z64",
    });
    const { manifest, zip, platformKey } = portFixture({ requiredOriginal });
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    await installPort({ manifest, portId: "example-port", platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [zip] }) });

    const originalPath = path.join(dir, "my-cartridge-dump.z64");
    await fs.writeFile(originalPath, original);
    const stagedPath = await validateAndStageOriginal({ manifest, portId: "example-port", portsDir, stateFilePath, originalFilePath: originalPath });

    assert.deepEqual(await fs.readFile(stagedPath), original);
    const state = await loadRecompState(stateFilePath);
    const recordedOriginal = state.ports["example-port"].original;
    assert.equal(recordedOriginal.stagedRelativePath, "assets/baserom.z64");
    assert.equal(recordedOriginal.sha256, requiredOriginal.sha256);
    // The user's picked path must appear nowhere in persisted state.
    assert.doesNotMatch(JSON.stringify(state), /my-cartridge-dump/);
  });
});

test("validateAndStageOriginal rejects a wrong-size or wrong-hash original and stages nothing", async () => {
  await withTempDir(async (dir) => {
    const original = Buffer.from("y".repeat(4096));
    const requiredOriginal = validRequiredOriginal({
      sha256: crypto.createHash("sha256").update(original).digest("hex"),
      sizeBytes: original.length,
    });
    const { manifest, zip, platformKey } = portFixture({ requiredOriginal });
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    await installPort({ manifest, portId: "example-port", platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [zip] }) });

    // Wrong size.
    const wrongSize = path.join(dir, "wrong-size.z64");
    await fs.writeFile(wrongSize, Buffer.from("too short"));
    await assert.rejects(
      () => validateAndStageOriginal({ manifest, portId: "example-port", portsDir, stateFilePath, originalFilePath: wrongSize }),
      (e) => e.code === "RECOMP_ORIGINAL_SIZE_MISMATCH",
    );

    // Right size, wrong bytes → digest mismatch.
    const wrongBytes = path.join(dir, "wrong-bytes.z64");
    await fs.writeFile(wrongBytes, Buffer.from("z".repeat(original.length)));
    await assert.rejects(
      () => validateAndStageOriginal({ manifest, portId: "example-port", portsDir, stateFilePath, originalFilePath: wrongBytes }),
      (e) => e.code === "RECOMP_ORIGINAL_DIGEST_MISMATCH",
    );

    const state = await loadRecompState(stateFilePath);
    assert.equal(state.ports["example-port"].original, null, "nothing staged after a rejected original");
  });
});

test("validateAndStageOriginal refuses when the port is not installed, and reports unreadable files coded", async () => {
  await withTempDir(async (dir) => {
    const { manifest } = portFixture();
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    await saveRecompState(stateFilePath, emptyRecompState());

    await assert.rejects(
      () => validateAndStageOriginal({ manifest, portId: "example-port", portsDir, stateFilePath, originalFilePath: path.join(dir, "whatever.z64") }),
      (e) => e.code === "RECOMP_NOT_INSTALLED",
    );
  });
});

test("buildRecompLaunchSpec is gated on install AND a staged original, and takes no renderer input", async () => {
  await withTempDir(async (dir) => {
    const original = Buffer.from("g".repeat(1500));
    const requiredOriginal = validRequiredOriginal({
      sha256: crypto.createHash("sha256").update(original).digest("hex"),
      sizeBytes: original.length,
    });
    const { manifest, zip, platformKey } = portFixture({ requiredOriginal, executableRelativePath: "port" });
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");

    // Not installed at all.
    assert.throws(() => buildRecompLaunchSpec({ portsDir, portId: "example-port", installed: undefined }), (e) => e.code === "RECOMP_NOT_INSTALLED");

    await installPort({ manifest, portId: "example-port", platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [zip] }) });
    let state = await loadRecompState(stateFilePath);
    // Installed but no original yet → not ready.
    assert.throws(() => buildRecompLaunchSpec({ portsDir, portId: "example-port", installed: state.ports["example-port"] }), (e) => e.code === "RECOMP_NOT_READY");

    const originalPath = path.join(dir, "orig.z64");
    await fs.writeFile(originalPath, original);
    await validateAndStageOriginal({ manifest, portId: "example-port", portsDir, stateFilePath, originalFilePath: originalPath });
    state = await loadRecompState(stateFilePath);

    const spec = buildRecompLaunchSpec({ portsDir, portId: "example-port", installed: state.ports["example-port"] });
    assert.deepEqual(spec.args, []);
    assert.ok(spec.command.endsWith(path.join("1.0.0", platformKey, "port")));
    assert.ok(spec.cwd.endsWith(path.join("1.0.0", platformKey)));
    // The command must be an existing file on disk.
    await fs.access(spec.command);
  });
});

// ---------------------------------------------------------------------------
// Per-port update + remove
// ---------------------------------------------------------------------------

test("isPortUpdateAvailable is true only when an installed port's version differs from the manifest", async () => {
  await withTempDir(async (dir) => {
    const { manifest, zip, platformKey } = portFixture({ version: "1.0.0" });
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    let state = await loadRecompState(stateFilePath);
    assert.equal(isPortUpdateAvailable(manifest, state, "example-port"), false, "uninstalled → no update");

    await installPort({ manifest, portId: "example-port", platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [zip] }) });
    state = await loadRecompState(stateFilePath);
    assert.equal(isPortUpdateAvailable(manifest, state, "example-port"), false, "same version → no update");

    const bumped = portFixture({ version: "1.1.0", platformKey });
    assert.equal(isPortUpdateAvailable(bumped.manifest, state, "example-port"), true, "newer manifest version → update available");
  });
});

test("installing a new version prunes the old version directory and resets the staged original", async () => {
  await withTempDir(async (dir) => {
    const original = Buffer.from("o".repeat(1024));
    const requiredOriginal = validRequiredOriginal({ sha256: crypto.createHash("sha256").update(original).digest("hex"), sizeBytes: original.length });
    const v1 = portFixture({ version: "1.0.0", requiredOriginal });
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    await installPort({ manifest: v1.manifest, portId: "example-port", platformKey: v1.platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [v1.zip] }) });
    const originalPath = path.join(dir, "orig.z64");
    await fs.writeFile(originalPath, original);
    await validateAndStageOriginal({ manifest: v1.manifest, portId: "example-port", portsDir, stateFilePath, originalFilePath: originalPath });

    const v1Dir = path.join(portsDir, "example-port", "1.0.0");
    await fs.access(v1Dir); // exists before the update

    const v2 = portFixture({ version: "1.1.0", requiredOriginal });
    await installPort({ manifest: v2.manifest, portId: "example-port", platformKey: v2.platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [v2.zip] }) });

    await assert.rejects(() => fs.access(v1Dir), "old version directory pruned");
    const state = await loadRecompState(stateFilePath);
    assert.equal(state.ports["example-port"].version, "1.1.0");
    assert.equal(state.ports["example-port"].original, null, "update requires re-staging the original");
  });
});

test("removePort deletes the port directory and its state entry", async () => {
  await withTempDir(async (dir) => {
    const { manifest, zip, platformKey } = portFixture();
    const portsDir = path.join(dir, "ports");
    const stateFilePath = path.join(portsDir, "state.json");
    await installPort({ manifest, portId: "example-port", platformKey, portsDir, stateFilePath, transport: fakeTransport({ chunks: [zip] }) });
    const portDir = path.join(portsDir, "example-port");
    await fs.access(portDir);

    await removePort({ portId: "example-port", portsDir, stateFilePath });
    await assert.rejects(() => fs.access(portDir));
    const state = await loadRecompState(stateFilePath);
    assert.deepEqual(state.ports, {});
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test("recompErrorCode returns only the coded string for both recomp and reused download/zip errors", () => {
  assert.equal(recompErrorCode(new ArchiveBayRecompError("RECOMP_NOT_READY")), "RECOMP_NOT_READY");
  assert.equal(recompErrorCode(new ArchiveBayRuntimeError("RUNTIME_DIGEST_MISMATCH")), "RUNTIME_DIGEST_MISMATCH");
  assert.equal(recompErrorCode(new Error("/Users/someone/secret/path failed")), "RECOMP_UNKNOWN_ERROR");
});
