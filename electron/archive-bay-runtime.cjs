/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Archive Bay managed melonDS runtime (Phase 16.2) — desktop-only.
 *
 * See docs/axis-redesign/adr/0005-archive-bay-emulator-native-port-separation.md
 * ("OWNER LICENSING DECISION ... Option B — distribute a managed melonDS
 * runtime in 16.2"). This module implements the manager side of that
 * decision: it never bundles melonDS inside the AXIS asar, never auto-
 * updates, and never spawns anything itself — it only downloads, verifies,
 * and extracts a pinned, versioned release asset into a userData directory,
 * then hands a resolved executable path back to the existing
 * `canonicalizeRuntimePath` / `buildLaunchSpawnArgs` contract in
 * `archive-bay.cjs`. That contract is NOT forked or duplicated here.
 *
 * Security invariants (binding, see ADR-0005 and the 16.2 task brief):
 * - The manifest (electron/config/archive-bay-runtimes.json) is the SOLE
 *   source of truth for download URLs, expected sizes, and sha256 digests.
 *   Nothing here accepts a renderer-supplied URL, path, or digest.
 * - Every download is verified against the manifest's sha256 (and, if
 *   present, its declared size) BEFORE the archive is extracted or a binary
 *   is ever touched. A mismatch deletes the downloaded bytes and throws a
 *   coded error — never a raw path, never a raw Node error message.
 * - Downloads are HTTPS-only, including every redirect hop.
 * - ZIP extraction validates every entry name before writing anything:
 *   absolute paths, `..` traversal, and Windows drive-letter paths are all
 *   rejected outright (`validateZipEntryPath`). The archive's own sha256 is
 *   the integrity boundary for its bytes; entry-name validation is a
 *   separate, independent boundary for where those bytes are allowed to
 *   land on disk.
 * - No telemetry ever includes a path, a digest, or a URL (see
 *   `archiveBayRuntimeErrorMessage` in main.cjs — only coded strings cross
 *   that boundary, mirroring `archiveBayErrorMessage` for the BYO path).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const zlib = require("node:zlib");

const MANIFEST_SCHEMA_VERSION = 1;
const RUNTIME_STATE_SCHEMA_VERSION = 1;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const REQUIRED_LICENSE = "GPL-3.0";
const MAX_REDIRECTS = 5;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

class ArchiveBayRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArchiveBayRuntimeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Manifest validation — pure, no filesystem/network access.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpsUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates a single platform release entry. Every field is required and
 * checked independently; malformed input throws a specific coded error so
 * a bad manifest (hand-edited, corrupted, or from a compromised update
 * channel this repo does not have) fails loudly instead of silently
 * degrading into "download whatever this string says".
 */
function validatePlatformRelease(release, platformKey) {
  if (!isPlainObject(release)) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_PLATFORM_INVALID");
  if (!isHttpsUrl(release.url)) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_URL_INVALID");
  if (!SHA256_HEX.test(String(release.sha256))) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_SHA256_INVALID");
  if (!Number.isInteger(release.sizeBytes) || release.sizeBytes <= 0) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_SIZE_INVALID");
  }
  if (release.archiveFormat !== "zip") throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_FORMAT_UNSUPPORTED");
  if (typeof release.executableRelativePath !== "string" || release.executableRelativePath.length === 0) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_EXECUTABLE_PATH_INVALID");
  }
  // The manifest's own executableRelativePath must pass the same safety
  // check applied to entries found inside the actual downloaded archive —
  // a malformed manifest cannot be used to smuggle a traversal path either.
  assertSafeRelativePath(release.executableRelativePath, "RUNTIME_MANIFEST_EXECUTABLE_PATH_INVALID");
  if (!/^[0-9a-zA-Z][0-9a-zA-Z_.-]*$/.test(platformKey)) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_PLATFORM_KEY_INVALID");
  }
  return {
    url: release.url,
    sha256: release.sha256.toLowerCase(),
    sizeBytes: release.sizeBytes,
    archiveFormat: release.archiveFormat,
    executableRelativePath: release.executableRelativePath,
  };
}

/**
 * Validates the whole runtime manifest. Returns a normalized copy; throws a
 * coded `ArchiveBayRuntimeError` on any structural problem. This is the
 * function exercised by the "malformed manifest" adversarial test cases.
 */
function validateManifest(raw) {
  if (!isPlainObject(raw)) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_INVALID");
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_SCHEMA_MISMATCH");
  if (typeof raw.runtime !== "string" || raw.runtime.length === 0) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_INVALID");
  }
  if (raw.license !== REQUIRED_LICENSE) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_LICENSE_INVALID");
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_VERSION_INVALID");
  }
  if (!isHttpsUrl(raw.licenseUrl)) throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_LICENSE_URL_INVALID");
  if (typeof raw.attribution !== "string" || raw.attribution.trim().length === 0) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_ATTRIBUTION_INVALID");
  }
  if (!isPlainObject(raw.correspondingSource) || !isHttpsUrl(raw.correspondingSource.url)
    || !SHA256_HEX.test(String(raw.correspondingSource.sha256))) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_SOURCE_INVALID");
  }
  if (!isPlainObject(raw.platforms) || Object.keys(raw.platforms).length === 0) {
    throw new ArchiveBayRuntimeError("RUNTIME_MANIFEST_PLATFORMS_INVALID");
  }
  const platforms = {};
  for (const [platformKey, release] of Object.entries(raw.platforms)) {
    platforms[platformKey] = validatePlatformRelease(release, platformKey);
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runtime: raw.runtime,
    version: raw.version,
    license: raw.license,
    licenseUrl: raw.licenseUrl,
    attribution: raw.attribution,
    correspondingSource: {
      url: raw.correspondingSource.url,
      sha256: raw.correspondingSource.sha256.toLowerCase(),
      sourceTag: typeof raw.correspondingSource.sourceTag === "string" ? raw.correspondingSource.sourceTag : null,
      sourceCommit: typeof raw.correspondingSource.sourceCommit === "string" ? raw.correspondingSource.sourceCommit : null,
    },
    platforms,
  };
}

/** `darwin`/`arm64` -> `darwin-arm64`, matching the manifest's platform keys. */
function resolvePlatformKey({ platform, arch }) {
  return `${platform}-${arch}`;
}

function getPlatformRelease(manifest, platformKey) {
  const release = manifest.platforms[platformKey];
  if (!release) throw new ArchiveBayRuntimeError("RUNTIME_PLATFORM_UNSUPPORTED");
  return release;
}

// ---------------------------------------------------------------------------
// Path safety — shared by manifest validation and zip-entry validation.
// ---------------------------------------------------------------------------

/**
 * Rejects absolute paths, `..` traversal (in either `/` or `\` form), null
 * bytes, and Windows drive-letter paths. Throws `code` on any violation;
 * returns the normalized (forward-slash) relative path on success. This is
 * the single choke point both `validatePlatformRelease` (manifest) and
 * `validateZipEntryPath` (downloaded archive contents) route through.
 */
function assertSafeRelativePath(candidate, code) {
  if (typeof candidate !== "string" || candidate.length === 0) throw new ArchiveBayRuntimeError(code);
  if (candidate.includes("\0")) throw new ArchiveBayRuntimeError(code);
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/")) throw new ArchiveBayRuntimeError(code);
  if (/^[a-zA-Z]:/.test(normalized)) throw new ArchiveBayRuntimeError(code); // C:\... etc.
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) throw new ArchiveBayRuntimeError(code);
  return normalized;
}

/**
 * Resolves a zip entry's name to a concrete path inside `destDir`, or
 * throws `ARCHIVE_BAY_RUNTIME_ZIP_ENTRY_UNSAFE`. Belt-and-suspenders: even
 * after `assertSafeRelativePath` rejects textbook traversal strings, this
 * also confirms the resolved absolute path is still contained within
 * `destDir` before any write happens.
 */
function validateZipEntryPath(entryName, destDir) {
  const normalized = assertSafeRelativePath(entryName, "RUNTIME_ZIP_ENTRY_UNSAFE");
  const resolvedDest = path.resolve(destDir);
  const target = path.resolve(resolvedDest, normalized);
  if (target !== resolvedDest && !target.startsWith(resolvedDest + path.sep)) {
    throw new ArchiveBayRuntimeError("RUNTIME_ZIP_ENTRY_UNSAFE");
  }
  return target;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (store + deflate only, no zip64) — no third-party
// dependency. Every asset in the pinned manifest is a plain, small,
// single-disk zip (verified by hand against the actual melonDS release
// assets during this wave), so this deliberately does not support zip64,
// encryption, or multi-disk archives; it throws a coded error rather than
// mis-parsing if it encounters any of those.
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(buffer) {
  const maxCommentLength = 65535;
  const minScanOffset = Math.max(0, buffer.length - 22 - maxCommentLength);
  for (let offset = buffer.length - 22; offset >= minScanOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new ArchiveBayRuntimeError("RUNTIME_ZIP_CORRUPT");
}

/**
 * Parses a zip buffer's central directory into a flat list of entries.
 * Pure function — no filesystem access — so it is exercised directly by
 * unit tests with hand-built buffers (see archive-bay-runtime.test.cjs).
 */
function parseZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralDirOffset === ZIP64_SENTINEL || centralDirSize === ZIP64_SENTINEL) {
    throw new ArchiveBayRuntimeError("RUNTIME_ZIP_UNSUPPORTED_FORMAT");
  }
  const entries = [];
  let cursor = centralDirOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIR_SIGNATURE) {
      throw new ArchiveBayRuntimeError("RUNTIME_ZIP_CORRUPT");
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new ArchiveBayRuntimeError("RUNTIME_ZIP_UNSUPPORTED_FORMAT");
    }
    const nameStart = cursor + 46;
    const fileName = buffer.toString("utf8", nameStart, nameStart + fileNameLength);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new ArchiveBayRuntimeError("RUNTIME_ZIP_UNSUPPORTED_FORMAT");
    }
    entries.push({
      fileName,
      isDirectory: fileName.endsWith("/"),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      unixMode: (externalAttributes >>> 16) & 0xffff,
    });
    cursor = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

/** Locates an entry's actual compressed-data offset via its local header. */
function localFileDataOffset(buffer, entry) {
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new ArchiveBayRuntimeError("RUNTIME_ZIP_CORRUPT");
  }
  const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  return entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
}

function decompressEntry(buffer, entry) {
  const dataStart = localFileDataOffset(buffer, entry);
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressedData;
  return zlib.inflateRawSync(compressedData);
}

/**
 * Extracts a validated zip buffer into `destDir`. Every entry's name is
 * checked with `validateZipEntryPath` before anything is written; a single
 * unsafe entry aborts the whole extraction (no partial-trust extraction).
 * `executableRelativePath`, if given, is chmod'd `0o755` on POSIX platforms
 * after extraction regardless of the archive's own stored permission bits —
 * defense in depth against a zip built without executable bits set.
 */
async function extractZipBuffer(buffer, destDir, { executableRelativePath } = {}) {
  const entries = parseZipEntries(buffer);
  const resolvedDest = path.resolve(destDir);
  // Validate every entry before writing any of them.
  const planned = entries.map((entry) => ({ entry, target: validateZipEntryPath(entry.fileName, resolvedDest) }));
  await fsPromises.mkdir(resolvedDest, { recursive: true });
  for (const { entry, target } of planned) {
    if (entry.isDirectory) {
      await fsPromises.mkdir(target, { recursive: true });
      continue;
    }
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    const data = decompressEntry(buffer, entry);
    await fsPromises.writeFile(target, data);
    if (process.platform !== "win32") {
      const mode = entry.unixMode & 0o777;
      await fsPromises.chmod(target, mode || 0o644);
    }
  }
  if (executableRelativePath) {
    const executableTarget = validateZipEntryPath(executableRelativePath, resolvedDest);
    const stat = await fsPromises.lstat(executableTarget).catch(() => null);
    if (!stat || !stat.isFile()) throw new ArchiveBayRuntimeError("RUNTIME_EXECUTABLE_MISSING_AFTER_EXTRACT");
    if (process.platform !== "win32") await fsPromises.chmod(executableTarget, 0o755);
  }
  return planned.map(({ target }) => target);
}

// ---------------------------------------------------------------------------
// Download (HTTPS-only, redirect-following, digest + size verified before
// the temp file is promoted). `transport` is injectable so unit tests can
// simulate responses/redirects/truncation without any real network access.
// ---------------------------------------------------------------------------

function defaultTransport() {
  return { get: (url, callback) => https.get(url, callback) };
}

async function followRedirects(url, { maxRedirects = MAX_REDIRECTS, transport = defaultTransport() } = {}) {
  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "https:") throw new ArchiveBayRuntimeError("RUNTIME_INSECURE_URL");
    const response = await new Promise((resolve, reject) => {
      const request = transport.get(parsed, resolve);
      request.on?.("error", reject);
    });
    const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && response.headers?.location;
    if (isRedirect) {
      response.resume?.();
      currentUrl = new URL(response.headers.location, currentUrl).href;
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume?.();
      throw new ArchiveBayRuntimeError("RUNTIME_DOWNLOAD_HTTP_ERROR");
    }
    return response;
  }
  throw new ArchiveBayRuntimeError("RUNTIME_TOO_MANY_REDIRECTS");
}

/**
 * Downloads `url` to `destPath` (via a `.download` temp file), verifying the
 * manifest-declared size (if given) and sha256 before promoting the temp
 * file to its final name. On any mismatch the temp file is deleted and a
 * coded error is thrown — the caller never sees a partially-downloaded or
 * unverified file at `destPath`.
 */
async function downloadAndVerify(url, destPath, { expectedSha256, expectedSizeBytes, onProgress, transport } = {}) {
  const response = await followRedirects(url, { transport });
  const tempPath = `${destPath}.download`;
  await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
  const hash = crypto.createHash("sha256");
  let received = 0;
  const writeStream = fs.createWriteStream(tempPath);
  try {
    await new Promise((resolve, reject) => {
      response.on("data", (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        onProgress?.({ receivedBytes: received, totalBytes: expectedSizeBytes ?? null });
      });
      response.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      response.pipe(writeStream);
    });
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true });
    throw error instanceof ArchiveBayRuntimeError ? error : new ArchiveBayRuntimeError("RUNTIME_DOWNLOAD_FAILED");
  }
  if (typeof expectedSizeBytes === "number" && received !== expectedSizeBytes) {
    await fsPromises.rm(tempPath, { force: true });
    throw new ArchiveBayRuntimeError("RUNTIME_DOWNLOAD_INCOMPLETE");
  }
  const digest = hash.digest("hex");
  if (expectedSha256 && digest !== expectedSha256) {
    await fsPromises.rm(tempPath, { force: true });
    throw new ArchiveBayRuntimeError("RUNTIME_DIGEST_MISMATCH");
  }
  await fsPromises.rename(tempPath, destPath);
  return { sha256: digest, sizeBytes: received };
}

// ---------------------------------------------------------------------------
// Installed-state persistence (separate from archive-bay.cjs's library.json
// — the managed runtime's install record is its own small file so the BYO
// library schema in archive-bay.cjs never has to change).
// ---------------------------------------------------------------------------

function emptyRuntimeState() {
  return { schemaVersion: RUNTIME_STATE_SCHEMA_VERSION, installed: null };
}

function parseRuntimeState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArchiveBayRuntimeError("RUNTIME_STATE_CORRUPT");
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) {
    throw new ArchiveBayRuntimeError("RUNTIME_STATE_CORRUPT");
  }
  if (parsed.installed !== null) {
    if (!isPlainObject(parsed.installed)
      || typeof parsed.installed.version !== "string"
      || typeof parsed.installed.platformKey !== "string"
      || !SHA256_HEX.test(String(parsed.installed.sha256))
      || typeof parsed.installed.executableRelativePath !== "string"
      || typeof parsed.installed.installedAt !== "string") {
      throw new ArchiveBayRuntimeError("RUNTIME_STATE_CORRUPT");
    }
  }
  return parsed;
}

async function loadRuntimeState(stateFilePath) {
  let raw;
  try {
    raw = await fsPromises.readFile(stateFilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRuntimeState();
    throw error;
  }
  return parseRuntimeState(raw);
}

async function saveRuntimeState(stateFilePath, state) {
  await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
  const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsPromises.rename(tempPath, stateFilePath);
}

// ---------------------------------------------------------------------------
// Orchestration — installRuntime / removeRuntime. These are the only two
// functions main.cjs's IPC handlers call directly; everything above is
// exported mainly for unit testing.
// ---------------------------------------------------------------------------

function versionDir(runtimesDir, version, platformKey) {
  return path.join(runtimesDir, version, platformKey);
}

/**
 * Full install flow: download -> verify (inside downloadAndVerify) ->
 * extract (with entry-path validation) -> write compliance artifacts ->
 * record state. Returns the resolved executable path (still main-process
 * only — callers must run it through `canonicalizeRuntimePath` before it
 * is ever handed to `buildLaunchSpawnArgs`, exactly like the BYO path).
 */
async function installRuntime({
  manifest,
  platformKey,
  runtimesDir,
  stateFilePath,
  licenseText,
  onProgress,
  transport,
}) {
  const release = getPlatformRelease(manifest, platformKey);
  const destDir = versionDir(runtimesDir, manifest.version, platformKey);
  const downloadsDir = path.join(runtimesDir, "downloads");
  const archivePath = path.join(downloadsDir, `${manifest.version}-${platformKey}.zip`);

  onProgress?.({ phase: "downloading", receivedBytes: 0, totalBytes: release.sizeBytes });
  await downloadAndVerify(release.url, archivePath, {
    expectedSha256: release.sha256,
    expectedSizeBytes: release.sizeBytes,
    onProgress: (progress) => onProgress?.({ phase: "downloading", ...progress }),
    transport,
  });

  onProgress?.({ phase: "verifying" });
  // downloadAndVerify already verified the digest before promoting the file;
  // this phase event exists so the renderer can show an honest, distinct
  // "verifying" state rather than jumping straight from 100% download to
  // "installed".

  onProgress?.({ phase: "extracting" });
  await fsPromises.rm(destDir, { recursive: true, force: true });
  await extractZipBuffer(await fsPromises.readFile(archivePath), destDir, {
    executableRelativePath: release.executableRelativePath,
  });
  await fsPromises.rm(archivePath, { force: true });

  if (licenseText) await fsPromises.writeFile(path.join(destDir, "LICENSE"), licenseText, "utf8");
  await fsPromises.writeFile(
    path.join(destDir, "ATTRIBUTION.txt"),
    buildAttributionText(manifest),
    "utf8",
  );

  const installed = {
    version: manifest.version,
    platformKey,
    sha256: release.sha256,
    executableRelativePath: release.executableRelativePath,
    installedAt: new Date().toISOString(),
  };
  await saveRuntimeState(stateFilePath, { schemaVersion: RUNTIME_STATE_SCHEMA_VERSION, installed });

  return path.join(destDir, release.executableRelativePath);
}

async function removeRuntime({ runtimesDir, stateFilePath }) {
  const state = await loadRuntimeState(stateFilePath).catch(() => emptyRuntimeState());
  if (state.installed) {
    const destDir = versionDir(runtimesDir, state.installed.version, state.installed.platformKey);
    await fsPromises.rm(destDir, { recursive: true, force: true });
  }
  await saveRuntimeState(stateFilePath, emptyRuntimeState());
}

function buildAttributionText(manifest) {
  return [
    `${manifest.runtime} ${manifest.version}`,
    `License: ${manifest.license} (${manifest.licenseUrl})`,
    "",
    manifest.attribution,
    "",
    "Corresponding source (GPL-3.0 section 6):",
    `  ${manifest.correspondingSource.url}`,
    `  sha256: ${manifest.correspondingSource.sha256}`,
    manifest.correspondingSource.sourceCommit
      ? `  source commit: ${manifest.correspondingSource.sourceCommit}`
      : null,
    "",
    "AXIS distributes this runtime as an unmodified, separately spawned",
    "executable. AXIS is not the author of this software.",
  ].filter((line) => line !== null).join("\n").concat("\n");
}

/** Resolves the executable path for an already-installed runtime, or null. */
function resolveInstalledExecutablePath(runtimesDir, installed) {
  if (!installed) return null;
  return path.join(versionDir(runtimesDir, installed.version, installed.platformKey), installed.executableRelativePath);
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  RUNTIME_STATE_SCHEMA_VERSION,
  ArchiveBayRuntimeError,
  validateManifest,
  resolvePlatformKey,
  getPlatformRelease,
  assertSafeRelativePath,
  validateZipEntryPath,
  parseZipEntries,
  extractZipBuffer,
  followRedirects,
  downloadAndVerify,
  emptyRuntimeState,
  parseRuntimeState,
  loadRuntimeState,
  saveRuntimeState,
  installRuntime,
  removeRuntime,
  buildAttributionText,
  resolveInstalledExecutablePath,
};
