/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Archive Bay native-recompilation port adapter (Phase 16.3) — desktop-only.
 *
 * See docs/axis-redesign/adr/0005-archive-bay-emulator-native-port-separation.md
 * (option 4, the `native-recomp` LegacyRuntimeKind). A "native port" is a
 * standalone native executable that reimplements a specific legacy game
 * (think the community N64/DS recompilation projects). The port BINARY
 * contains none of the original game's copyrighted assets: it extracts them,
 * on the user's own machine, from an original the user already legally owns.
 *
 * This adapter is the manager side of that model. It is the sibling of
 * `archive-bay-runtime.cjs` (16.2, the managed melonDS emulator) and
 * deliberately REUSES that module's hardened, adversarially-tested download,
 * zip-extraction, and path-safety primitives rather than forking them. What
 * it adds on top is the recomp-specific layer:
 *
 *   1. A MULTI-PORT manifest (`electron/config/archive-bay-recomp-ports.json`)
 *      — the sole source of truth for every port's binary download URL, size,
 *      and sha256, its license/corresponding-source, and the sha256 of the
 *      original game file it requires. Nothing here is renderer-suppliable.
 *   2. USER-SUPPLIED ORIGINAL validation — the user picks their own original
 *      via a native OS file dialog (main.cjs, never the renderer); this module
 *      streams it, checks its size and sha256 against the manifest, and only
 *      then stages it locally into the port's own directory. A wrong or
 *      incomplete file is rejected with a coded error; nothing is staged.
 *   3. Per-port install state, so ports install/update/remove independently.
 *
 * BINDING legal + security invariants (ADR-0005 and the 16.3 brief):
 * - AXIS ships and downloads ONLY the port binary (the port project's own
 *   code, pinned with its license + corresponding-source exactly like the
 *   16.2 managed runtime). AXIS never downloads, hosts, bundles, indexes,
 *   scrapes, or links to the original game or its assets.
 * - `requiredOriginal.sha256` is a one-way VALIDATION digest, not a locator.
 *   It confirms the user supplied the exact, complete original they claim to
 *   own; it cannot be used to obtain the game. There is deliberately no URL
 *   for the original anywhere in the schema. (This is the same "your dump
 *   must match this hash" pattern every reputable recomp project uses.)
 * - The user's original and every resolved filesystem path stay in the main
 *   process. The renderer only ever sees the opaque `portId`, coded status,
 *   and coded errors — never a path, a URL, or a raw Node error message.
 * - Downloads are HTTPS-only and sha256+size verified before extraction
 *   (inherited from `downloadAndVerify`); archive entries are traversal-
 *   validated before any write (inherited from `extractZipBuffer`).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const {
  ArchiveBayRuntimeError,
  assertSafeRelativePath,
  downloadAndVerify,
  extractZipBuffer,
} = require("./archive-bay-runtime.cjs");

const RECOMP_MANIFEST_SCHEMA_VERSION = 1;
const RECOMP_STATE_SCHEMA_VERSION = 1;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const PORT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Recomp-specific coded error. Kept as its own class so callers can tell a
 * recomp-layer failure from a reused download/zip failure (which surfaces as
 * `ArchiveBayRuntimeError` with a `RUNTIME_*` code); the main-process error
 * mapper treats both as "return `error.code`, never a raw path".
 */
class ArchiveBayRecompError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArchiveBayRecompError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small local predicates (the runtime module keeps its equivalents private;
// these are a handful of lines, so re-declaring them is cheaper than widening
// that module's export surface).
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Manifest validation — pure, no filesystem/network access. Exercised
// directly by the adversarial "malformed manifest" test cases.
// ---------------------------------------------------------------------------

function validatePlatformRelease(release) {
  if (!isPlainObject(release)) throw new ArchiveBayRecompError("RECOMP_PORT_PLATFORM_INVALID");
  if (!isHttpsUrl(release.url)) throw new ArchiveBayRecompError("RECOMP_PORT_URL_INVALID");
  if (!SHA256_HEX.test(String(release.sha256))) throw new ArchiveBayRecompError("RECOMP_PORT_SHA256_INVALID");
  if (!Number.isInteger(release.sizeBytes) || release.sizeBytes <= 0) {
    throw new ArchiveBayRecompError("RECOMP_PORT_SIZE_INVALID");
  }
  if (release.archiveFormat !== "zip") throw new ArchiveBayRecompError("RECOMP_PORT_FORMAT_UNSUPPORTED");
  if (!isNonEmptyString(release.executableRelativePath)) {
    throw new ArchiveBayRecompError("RECOMP_PORT_EXECUTABLE_PATH_INVALID");
  }
  // The manifest's own executableRelativePath must survive the same traversal
  // check the downloaded archive's entries do — a malformed manifest cannot
  // smuggle an escape path either.
  assertSafeRelativePath(release.executableRelativePath, "RECOMP_PORT_EXECUTABLE_PATH_INVALID");
  return {
    url: release.url,
    sha256: release.sha256.toLowerCase(),
    sizeBytes: release.sizeBytes,
    archiveFormat: release.archiveFormat,
    executableRelativePath: release.executableRelativePath,
  };
}

function validateRequiredOriginal(spec) {
  if (!isPlainObject(spec)) throw new ArchiveBayRecompError("RECOMP_ORIGINAL_SPEC_INVALID");
  if (!isNonEmptyString(spec.label)) throw new ArchiveBayRecompError("RECOMP_ORIGINAL_SPEC_INVALID");
  if (!SHA256_HEX.test(String(spec.sha256))) throw new ArchiveBayRecompError("RECOMP_ORIGINAL_SPEC_INVALID");
  if (!Number.isInteger(spec.sizeBytes) || spec.sizeBytes <= 0) {
    throw new ArchiveBayRecompError("RECOMP_ORIGINAL_SPEC_INVALID");
  }
  // `stagedName` is where the validated original is written inside the port
  // directory. It must be a safe, single-segment-ish relative path.
  if (!isNonEmptyString(spec.stagedName)) throw new ArchiveBayRecompError("RECOMP_ORIGINAL_SPEC_INVALID");
  assertSafeRelativePath(spec.stagedName, "RECOMP_ORIGINAL_SPEC_INVALID");
  const extensions = Array.isArray(spec.extensions) ? spec.extensions.filter(isNonEmptyString) : [];
  return {
    label: spec.label,
    sha256: spec.sha256.toLowerCase(),
    sizeBytes: spec.sizeBytes,
    stagedName: spec.stagedName,
    // Advisory only — the sha256 is the real gate. Used to pre-filter the OS
    // file picker so the user is not offered obviously-wrong files.
    extensions,
  };
}

function validatePort(port, portId) {
  if (!PORT_ID_PATTERN.test(portId)) throw new ArchiveBayRecompError("RECOMP_PORT_ID_INVALID");
  if (!isPlainObject(port)) throw new ArchiveBayRecompError("RECOMP_PORT_INVALID");
  if (!isNonEmptyString(port.name)) throw new ArchiveBayRecompError("RECOMP_PORT_INVALID");
  if (!isNonEmptyString(port.version)) throw new ArchiveBayRecompError("RECOMP_PORT_VERSION_INVALID");
  if (!isNonEmptyString(port.license)) throw new ArchiveBayRecompError("RECOMP_PORT_LICENSE_INVALID");
  if (!isHttpsUrl(port.licenseUrl)) throw new ArchiveBayRecompError("RECOMP_PORT_LICENSE_URL_INVALID");
  if (!isNonEmptyString(port.attribution)) throw new ArchiveBayRecompError("RECOMP_PORT_ATTRIBUTION_INVALID");
  if (!isPlainObject(port.correspondingSource)
    || !isHttpsUrl(port.correspondingSource.url)
    || !SHA256_HEX.test(String(port.correspondingSource.sha256))) {
    throw new ArchiveBayRecompError("RECOMP_PORT_SOURCE_INVALID");
  }
  const requiredOriginal = validateRequiredOriginal(port.requiredOriginal);
  if (!isPlainObject(port.platforms) || Object.keys(port.platforms).length === 0) {
    throw new ArchiveBayRecompError("RECOMP_PORT_PLATFORMS_INVALID");
  }
  const platforms = {};
  for (const [platformKey, release] of Object.entries(port.platforms)) {
    if (!/^[0-9a-zA-Z][0-9a-zA-Z_.-]*$/.test(platformKey)) {
      throw new ArchiveBayRecompError("RECOMP_PORT_PLATFORM_KEY_INVALID");
    }
    platforms[platformKey] = validatePlatformRelease(release);
  }
  return {
    id: portId,
    name: port.name,
    version: port.version,
    homepageUrl: isHttpsUrl(port.homepageUrl) ? port.homepageUrl : null,
    license: port.license,
    licenseUrl: port.licenseUrl,
    attribution: port.attribution,
    correspondingSource: {
      url: port.correspondingSource.url,
      sha256: port.correspondingSource.sha256.toLowerCase(),
      sourceTag: isNonEmptyString(port.correspondingSource.sourceTag) ? port.correspondingSource.sourceTag : null,
      sourceCommit: isNonEmptyString(port.correspondingSource.sourceCommit) ? port.correspondingSource.sourceCommit : null,
    },
    requiredOriginal,
    platforms,
  };
}

/**
 * Validates the whole recomp manifest. An EMPTY `ports` map is valid and
 * expected: the adapter ships with the machinery in place but no port enabled
 * (each real port is an owner-gated, separately-reviewed addition — a pinned
 * binary per platform plus the original's known sha256). Returns a normalized
 * copy keyed by portId; throws a coded error on any structural problem.
 */
function validateRecompManifest(raw) {
  if (!isPlainObject(raw)) throw new ArchiveBayRecompError("RECOMP_MANIFEST_INVALID");
  if (raw.schemaVersion !== RECOMP_MANIFEST_SCHEMA_VERSION) {
    throw new ArchiveBayRecompError("RECOMP_MANIFEST_SCHEMA_MISMATCH");
  }
  if (!isPlainObject(raw.ports)) throw new ArchiveBayRecompError("RECOMP_MANIFEST_INVALID");
  const ports = {};
  for (const [portId, port] of Object.entries(raw.ports)) {
    ports[portId] = validatePort(port, portId);
  }
  return { schemaVersion: RECOMP_MANIFEST_SCHEMA_VERSION, ports };
}

function getPort(manifest, portId) {
  const port = manifest.ports[portId];
  if (!port) throw new ArchiveBayRecompError("RECOMP_PORT_UNKNOWN");
  return port;
}

function getPortPlatformRelease(port, platformKey) {
  const release = port.platforms[platformKey];
  if (!release) throw new ArchiveBayRecompError("RECOMP_PLATFORM_UNSUPPORTED");
  return release;
}

// ---------------------------------------------------------------------------
// Installed-state persistence — a per-port map, independent of both
// archive-bay.cjs's BYO `library.json` and archive-bay-runtime.cjs's single
// managed-runtime `state.json`.
// ---------------------------------------------------------------------------

function emptyRecompState() {
  return { schemaVersion: RECOMP_STATE_SCHEMA_VERSION, ports: {} };
}

function validateInstalledOriginal(original) {
  if (original === null || original === undefined) return null;
  if (!isPlainObject(original)
    || !SHA256_HEX.test(String(original.sha256))
    || !isNonEmptyString(original.stagedRelativePath)
    || !isNonEmptyString(original.stagedAt)) {
    throw new ArchiveBayRecompError("RECOMP_STATE_CORRUPT");
  }
  return { sha256: original.sha256, stagedRelativePath: original.stagedRelativePath, stagedAt: original.stagedAt };
}

function validateInstalledPort(record) {
  if (!isPlainObject(record)
    || !isNonEmptyString(record.version)
    || !isNonEmptyString(record.platformKey)
    || !SHA256_HEX.test(String(record.sha256))
    || !isNonEmptyString(record.executableRelativePath)
    || !isNonEmptyString(record.installedAt)) {
    throw new ArchiveBayRecompError("RECOMP_STATE_CORRUPT");
  }
  return {
    version: record.version,
    platformKey: record.platformKey,
    sha256: record.sha256,
    executableRelativePath: record.executableRelativePath,
    installedAt: record.installedAt,
    original: validateInstalledOriginal(record.original),
  };
}

function parseRecompState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArchiveBayRecompError("RECOMP_STATE_CORRUPT");
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== RECOMP_STATE_SCHEMA_VERSION || !isPlainObject(parsed.ports)) {
    throw new ArchiveBayRecompError("RECOMP_STATE_CORRUPT");
  }
  const ports = {};
  for (const [portId, record] of Object.entries(parsed.ports)) {
    if (!PORT_ID_PATTERN.test(portId)) throw new ArchiveBayRecompError("RECOMP_STATE_CORRUPT");
    ports[portId] = validateInstalledPort(record);
  }
  return { schemaVersion: RECOMP_STATE_SCHEMA_VERSION, ports };
}

async function loadRecompState(stateFilePath) {
  let raw;
  try {
    raw = await fsPromises.readFile(stateFilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyRecompState();
    throw error;
  }
  return parseRecompState(raw);
}

async function saveRecompState(stateFilePath, state) {
  await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
  const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsPromises.rename(tempPath, stateFilePath);
}

// ---------------------------------------------------------------------------
// Filesystem layout. Everything for a port lives under
// <portsDir>/<portId>/<version>/<platformKey>/ so that different versions of
// the same port, and different ports, never collide — and a per-port update
// is just an install into a new version directory followed by pruning the old
// one.
// ---------------------------------------------------------------------------

function portVersionDir(portsDir, portId, version, platformKey) {
  return path.join(portsDir, portId, version, platformKey);
}

/** The assets directory for an installed port — where the validated original
 * is staged for the port binary to read. Kept alongside the binary so removing
 * the version directory removes the staged original too. */
function portAssetsDir(portsDir, portId, version, platformKey) {
  return path.join(portVersionDir(portsDir, portId, version, platformKey), "assets");
}

// ---------------------------------------------------------------------------
// Streaming sha256 + size of a user-chosen original. Streamed (not readFile)
// because an original game image can be hundreds of MB and must never be held
// whole in memory.
// ---------------------------------------------------------------------------

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), sizeBytes };
}

// ---------------------------------------------------------------------------
// Compliance text. Distinct from the managed runtime's because a recomp port
// carries an EXTRA, load-bearing statement: AXIS ships the port code only and
// never the game's assets, which the user supplies from their own original.
// ---------------------------------------------------------------------------

function buildRecompAttributionText(port) {
  return [
    `${port.name} ${port.version} (native recompilation port)`,
    `License: ${port.license} (${port.licenseUrl})`,
    port.homepageUrl ? `Project: ${port.homepageUrl}` : null,
    "",
    port.attribution,
    "",
    "Corresponding source (GPL-3.0 section 6, where applicable):",
    `  ${port.correspondingSource.url}`,
    `  sha256: ${port.correspondingSource.sha256}`,
    port.correspondingSource.sourceCommit ? `  source commit: ${port.correspondingSource.sourceCommit}` : null,
    "",
    "AXIS distributes ONLY this port's own executable, unmodified and",
    "separately spawned. AXIS is not the author of this software and ships",
    "none of the original game's assets. Those are extracted, on your own",
    "machine, from an original you supply and legally own — AXIS never",
    "downloads, hosts, or provides the original game.",
  ].filter((line) => line !== null).join("\n").concat("\n");
}

// ---------------------------------------------------------------------------
// Orchestration — installPort / validateAndStageOriginal / removePort /
// buildRecompLaunchSpec. These four are what main.cjs's IPC handlers call;
// everything above is exported mainly for unit testing.
// ---------------------------------------------------------------------------

/**
 * Downloads + verifies + extracts a port's BINARY (never any game asset),
 * writes its compliance artifacts, prunes any previously-installed version of
 * the same port, and records install state with `original: null` (the port is
 * installed but not yet launchable — the user must still supply their
 * original via `validateAndStageOriginal`). Returns the resolved executable
 * path (main-process only).
 */
async function installPort({ manifest, portId, platformKey, portsDir, stateFilePath, licenseText, onProgress, transport }) {
  const port = getPort(manifest, portId);
  const release = getPortPlatformRelease(port, platformKey);
  const destDir = portVersionDir(portsDir, portId, port.version, platformKey);
  const downloadsDir = path.join(portsDir, portId, "downloads");
  const archivePath = path.join(downloadsDir, `${port.version}-${platformKey}.zip`);

  onProgress?.({ phase: "downloading", receivedBytes: 0, totalBytes: release.sizeBytes });
  await downloadAndVerify(release.url, archivePath, {
    expectedSha256: release.sha256,
    expectedSizeBytes: release.sizeBytes,
    onProgress: (progress) => onProgress?.({ phase: "downloading", ...progress }),
    transport,
  });

  onProgress?.({ phase: "extracting" });
  await fsPromises.rm(destDir, { recursive: true, force: true });
  await extractZipBuffer(await fsPromises.readFile(archivePath), destDir, {
    executableRelativePath: release.executableRelativePath,
  });
  await fsPromises.rm(archivePath, { force: true });

  if (licenseText) await fsPromises.writeFile(path.join(destDir, "LICENSE"), licenseText, "utf8");
  await fsPromises.writeFile(path.join(destDir, "ATTRIBUTION.txt"), buildRecompAttributionText(port), "utf8");

  const state = await loadRecompState(stateFilePath).catch(() => emptyRecompState());
  state.ports[portId] = {
    version: port.version,
    platformKey,
    sha256: release.sha256,
    executableRelativePath: release.executableRelativePath,
    installedAt: new Date().toISOString(),
    // Always null on (re)install: the version directory — which physically
    // contains the staged original under assets/ — is wiped and re-extracted
    // just above, so any previously-staged original no longer exists on disk.
    // The user re-supplies it via validateAndStageOriginal. (This makes
    // "repair" and "update" behave identically and honestly.)
    original: null,
  };
  await saveRecompState(stateFilePath, state);

  // Prune every other version/platform directory for this port so a bump
  // doesn't leave stale binaries (and stale staged originals) on disk.
  await pruneOtherPortVersions(portsDir, portId, port.version, platformKey);

  onProgress?.({ phase: "installed", version: port.version });
  return path.join(destDir, release.executableRelativePath);
}

async function pruneOtherPortVersions(portsDir, portId, keepVersion, keepPlatformKey) {
  const portRoot = path.join(portsDir, portId);
  const versionEntries = await fsPromises.readdir(portRoot, { withFileTypes: true }).catch(() => []);
  for (const versionEntry of versionEntries) {
    if (!versionEntry.isDirectory() || versionEntry.name === "downloads") continue;
    const versionPath = path.join(portRoot, versionEntry.name);
    if (versionEntry.name !== keepVersion) {
      await fsPromises.rm(versionPath, { recursive: true, force: true });
      continue;
    }
    const platformEntries = await fsPromises.readdir(versionPath, { withFileTypes: true }).catch(() => []);
    for (const platformEntry of platformEntries) {
      if (platformEntry.isDirectory() && platformEntry.name !== keepPlatformKey) {
        await fsPromises.rm(path.join(versionPath, platformEntry.name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Validates a user-supplied original against the port's manifest entry (size
 * THEN sha256 — size is the cheap early-out) and, only on an exact match,
 * stages a copy inside the installed port's assets directory. The source path
 * the user picked is never persisted or returned; only the staged sha256 and
 * the port-relative staged path are recorded. Returns the staged absolute path
 * (main-process only).
 *
 * `originalFilePath` comes exclusively from a native OS file dialog in the main
 * process (see main.cjs) — never from the renderer.
 */
async function validateAndStageOriginal({ manifest, portId, portsDir, stateFilePath, originalFilePath }) {
  const port = getPort(manifest, portId);
  const state = await loadRecompState(stateFilePath);
  const installed = state.ports[portId];
  if (!installed) throw new ArchiveBayRecompError("RECOMP_NOT_INSTALLED");

  const assetsDir = portAssetsDir(portsDir, portId, installed.version, installed.platformKey);
  // Contain the staged name inside the assets dir even though the manifest's
  // stagedName already passed assertSafeRelativePath at load time.
  const stagedRelative = assertSafeRelativePath(port.requiredOriginal.stagedName, "RECOMP_ORIGINAL_SPEC_INVALID");
  const resolvedAssets = path.resolve(assetsDir);
  const stagedAbsolute = path.resolve(resolvedAssets, stagedRelative);
  if (stagedAbsolute !== resolvedAssets && !stagedAbsolute.startsWith(resolvedAssets + path.sep)) {
    throw new ArchiveBayRecompError("RECOMP_STAGE_PATH_UNSAFE");
  }

  // Copy first into a temp sibling, then hash and validate the STAGED bytes.
  // Hashing the picked source and copying it afterwards opens a TOCTOU: the
  // source (a user-picked path, possibly a symlink) can change between the
  // hash and the copy, so the digest we record would not describe the bytes we
  // keep. Hashing the copy closes that; the atomic rename means a prior valid
  // original survives a failed re-stage instead of being clobbered.
  await fsPromises.mkdir(path.dirname(stagedAbsolute), { recursive: true });
  const stagingTemp = `${stagedAbsolute}.incoming`;
  try {
    await fsPromises.copyFile(originalFilePath, stagingTemp);
  } catch {
    // A path-free code — never surface the picked file's path or a raw fs error.
    throw new ArchiveBayRecompError("RECOMP_ORIGINAL_UNREADABLE");
  }

  let measured;
  try {
    measured = await hashFile(stagingTemp);
    if (measured.sizeBytes !== port.requiredOriginal.sizeBytes) {
      throw new ArchiveBayRecompError("RECOMP_ORIGINAL_SIZE_MISMATCH");
    }
    if (measured.sha256 !== port.requiredOriginal.sha256) {
      throw new ArchiveBayRecompError("RECOMP_ORIGINAL_DIGEST_MISMATCH");
    }
  } catch (error) {
    await fsPromises.rm(stagingTemp, { force: true });
    if (error instanceof ArchiveBayRecompError) throw error;
    throw new ArchiveBayRecompError("RECOMP_ORIGINAL_UNREADABLE");
  }

  await fsPromises.rename(stagingTemp, stagedAbsolute);

  installed.original = {
    sha256: measured.sha256,
    stagedRelativePath: path.posix.join("assets", stagedRelative),
    stagedAt: new Date().toISOString(),
  };
  await saveRecompState(stateFilePath, state);
  return stagedAbsolute;
}

async function removePort({ portId, portsDir, stateFilePath }) {
  const state = await loadRecompState(stateFilePath).catch(() => emptyRecompState());
  await fsPromises.rm(path.join(portsDir, portId), { recursive: true, force: true });
  if (state.ports[portId]) {
    delete state.ports[portId];
    await saveRecompState(stateFilePath, state);
  }
}

/**
 * Whether an installed port at `manifest`'s current version differs from what
 * is recorded as installed (a per-port update is available). Returns false for
 * an uninstalled or unknown port.
 */
function isPortUpdateAvailable(manifest, state, portId) {
  const port = manifest.ports[portId];
  const installed = state.ports[portId];
  if (!port || !installed) return false;
  return installed.version !== port.version;
}

/**
 * Builds the deterministic spawn spec for launching an installed, ready port.
 * A port is "ready" only once its binary is installed AND its original has
 * been validated and staged. No renderer input reaches this: command and cwd
 * are derived entirely from install state and the on-disk layout, and args is
 * a fixed empty array (the port reads its staged assets from `cwd/assets`).
 * The caller still runs `command` through the same canonicalize + spawn
 * contract every other Archive Bay launch uses.
 */
function buildRecompLaunchSpec({ portsDir, portId, installed }) {
  if (!installed) throw new ArchiveBayRecompError("RECOMP_NOT_INSTALLED");
  if (!installed.original) throw new ArchiveBayRecompError("RECOMP_NOT_READY");
  const versionDir = portVersionDir(portsDir, portId, installed.version, installed.platformKey);
  return {
    command: path.join(versionDir, installed.executableRelativePath),
    args: [],
    cwd: versionDir,
  };
}

function recompErrorCode(error) {
  // Both the recomp layer and the reused download/zip layer throw coded
  // errors; either way return only the code, never a raw path/URL/message.
  if (error instanceof ArchiveBayRecompError) return error.code;
  if (error instanceof ArchiveBayRuntimeError) return error.code;
  return "RECOMP_UNKNOWN_ERROR";
}

/**
 * Whether `candidate` (an already-resolved absolute path) lives strictly inside
 * `containerDir` (also resolved). Spawn containment gate: a port's executable
 * must resolve to a path under its own version directory, so a traversal
 * segment or an in-directory symlink in the install record cannot point the
 * spawn at an arbitrary binary. Pure for testability.
 */
function pathContainedIn(containerDir, candidate) {
  const rel = path.relative(path.resolve(containerDir), path.resolve(candidate));
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

/**
 * A minimal, secret-free environment for spawning a downloaded third-party port
 * binary. It must NOT inherit the full main-process environment (which can
 * carry provider tokens/keys); pass only the standard OS runtime variables a
 * native process needs to start. Pure (platform + source env are arguments) so
 * the allowlist is unit-testable.
 */
function minimalSpawnEnv(platform, sourceEnv) {
  const allow =
    platform === "win32"
      ? ["PATH", "Path", "SystemRoot", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "COMMONPROGRAMFILES"]
      : ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_DATA_DIRS"];
  const env = {};
  for (const key of allow) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  return env;
}

module.exports = {
  RECOMP_MANIFEST_SCHEMA_VERSION,
  RECOMP_STATE_SCHEMA_VERSION,
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
  portVersionDir,
  portAssetsDir,
  pathContainedIn,
  minimalSpawnEnv,
};
