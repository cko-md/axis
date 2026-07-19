/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Archive Bay domain logic (Phase 16.1) — desktop-only, bring-your-own-
 * emulator local library.
 *
 * Pure/testable where possible (see archive-bay.test.cjs); the few functions
 * that touch the filesystem (sha256File, load/saveLibrary) are still kept
 * free of any Electron API so they can run under plain `node --test`.
 *
 * Threat model (see docs/axis-redesign/adr/0005-archive-bay-emulator-native-port-separation.md):
 * - The renderer never receives a real filesystem path. Every title is
 *   addressed by an opaque `contentId`; `toPublicLegacyTitle` is the ONLY
 *   function allowed to build a renderer-facing payload, and it never
 *   includes `romPath`.
 * - Both the ROM path and the runtime (emulator) executable path are only
 *   ever supplied by a native OS file-picker dialog in main.cjs — never a
 *   renderer-typed string — so this module never has to sanitize an
 *   arbitrary attacker-controlled path string for those two roles.
 * - `buildLaunchSpawnArgs` is the entire child-process contract: a fixed
 *   two-element argument array, `shell: false`, no flags, no env overrides.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const LEGACY_RUNTIME_KINDS = Object.freeze(["external-emulator", "managed-emulator", "native-recomp"]);
const ALLOWED_ROM_EXTENSIONS = Object.freeze([".nds"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIBRARY_ENTRIES = 500;
const MAX_LABEL_LENGTH = 120;
const LIBRARY_SCHEMA_VERSION = 1;

class ArchiveBayError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArchiveBayError";
    this.code = code;
  }
}

function isLegacyRuntimeKind(value) {
  return LEGACY_RUNTIME_KINDS.includes(value);
}

function hasAllowedExtension(filePath, allowedExtensions = ALLOWED_ROM_EXTENSIONS) {
  return allowedExtensions.includes(path.extname(filePath).toLowerCase());
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Resolve a candidate path to its real, symlink-free location and confirm it
 * is a regular file with an allowed extension. Throws a coded error rather
 * than returning null/false, so a caller cannot mistake "rejected" for
 * "absent". Even though 16.1 only ever calls this with a path chosen through
 * a native file dialog (never a renderer string), it still validates fully —
 * defense in depth, and this is the function the unit tests exercise
 * adversarially (traversal-shaped strings, wrong extension, symlink to a
 * disallowed file, missing file).
 */
async function canonicalizeImportPath(candidatePath, { allowedExtensions = ALLOWED_ROM_EXTENSIONS } = {}) {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new ArchiveBayError("ARCHIVE_BAY_PATH_INVALID");
  }
  let real;
  try {
    real = await fsPromises.realpath(candidatePath);
  } catch {
    throw new ArchiveBayError("ARCHIVE_BAY_PATH_UNREADABLE");
  }
  const stat = await fsPromises.lstat(real).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new ArchiveBayError("ARCHIVE_BAY_PATH_NOT_A_FILE");
  }
  if (!hasAllowedExtension(real, allowedExtensions)) {
    throw new ArchiveBayError("ARCHIVE_BAY_EXTENSION_NOT_ALLOWED");
  }
  return real;
}

/**
 * Same canonicalization for the runtime (emulator) executable: must resolve
 * to a real, existing file. No extension allowlist (executables have no
 * fixed extension across macOS/Windows/Linux) — the trust boundary here is
 * that the path came from a native "choose the melonDS you already
 * installed" file dialog, not that this function can prove it's melonDS.
 */
async function canonicalizeRuntimePath(candidatePath) {
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    throw new ArchiveBayError("ARCHIVE_BAY_PATH_INVALID");
  }
  let real;
  try {
    real = await fsPromises.realpath(candidatePath);
  } catch {
    throw new ArchiveBayError("ARCHIVE_BAY_PATH_UNREADABLE");
  }
  const stat = await fsPromises.lstat(real).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new ArchiveBayError("ARCHIVE_BAY_PATH_NOT_A_FILE");
  }
  return real;
}

function buildLegacyTitleRecord({ contentId, label, runtimeKind, sha256, addedAt }) {
  if (!CONTENT_ID.test(String(contentId))) throw new ArchiveBayError("ARCHIVE_BAY_CONTENT_ID_INVALID");
  if (!isLegacyRuntimeKind(runtimeKind)) throw new ArchiveBayError("ARCHIVE_BAY_RUNTIME_KIND_INVALID");
  if (!SHA256_HEX.test(String(sha256))) throw new ArchiveBayError("ARCHIVE_BAY_SHA256_INVALID");
  if (typeof addedAt !== "string" || Number.isNaN(Date.parse(addedAt))) {
    throw new ArchiveBayError("ARCHIVE_BAY_TIMESTAMP_INVALID");
  }
  const trimmedLabel = String(label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
  return {
    contentId,
    label: trimmedLabel || "Untitled import",
    runtimeKind,
    sha256,
    addedAt,
  };
}

/** Renderer-safe projection: never includes romPath (or any filesystem path). */
function toPublicLegacyTitle(record) {
  return {
    contentId: record.contentId,
    label: record.label,
    runtimeKind: record.runtimeKind,
    addedAt: record.addedAt,
  };
}

function emptyLibrary() {
  return { schemaVersion: LIBRARY_SCHEMA_VERSION, titles: new Map(), runtimePath: null };
}

function parseLibraryFile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArchiveBayError("ARCHIVE_BAY_LIBRARY_CORRUPT");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || parsed.schemaVersion !== LIBRARY_SCHEMA_VERSION
    || !Array.isArray(parsed.titles)
  ) {
    throw new ArchiveBayError("ARCHIVE_BAY_LIBRARY_CORRUPT");
  }
  if (parsed.titles.length > MAX_LIBRARY_ENTRIES) {
    throw new ArchiveBayError("ARCHIVE_BAY_LIBRARY_TOO_LARGE");
  }
  const titles = new Map();
  for (const rawTitle of parsed.titles) {
    if (!rawTitle || typeof rawTitle !== "object" || typeof rawTitle.romPath !== "string" || rawTitle.romPath.length === 0) {
      throw new ArchiveBayError("ARCHIVE_BAY_LIBRARY_CORRUPT");
    }
    const record = buildLegacyTitleRecord(rawTitle);
    if (titles.has(record.contentId)) throw new ArchiveBayError("ARCHIVE_BAY_LIBRARY_CORRUPT");
    titles.set(record.contentId, { ...record, romPath: rawTitle.romPath });
  }
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    titles,
    runtimePath: typeof parsed.runtimePath === "string" && parsed.runtimePath.length > 0 ? parsed.runtimePath : null,
  };
}

function serializeLibraryFile(library) {
  return `${JSON.stringify({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    runtimePath: library.runtimePath ?? null,
    titles: [...library.titles.values()],
  }, null, 2)}\n`;
}

async function loadLibrary(libraryFilePath) {
  let raw;
  try {
    raw = await fsPromises.readFile(libraryFilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyLibrary();
    throw error;
  }
  return parseLibraryFile(raw);
}

async function saveLibrary(libraryFilePath, library) {
  await fsPromises.mkdir(path.dirname(libraryFilePath), { recursive: true });
  const temporary = `${libraryFilePath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(temporary, serializeLibraryFile(library), "utf8");
  await fsPromises.rename(temporary, libraryFilePath);
}

/**
 * The whole child-process threat model in one function: a fixed
 * two-element argument array, shell disabled, no renderer-suppliable flags
 * of any kind. Both `runtimePath` and `romPath` must already be
 * main-process-resolved, real paths (see canonicalize* above) by the time
 * they reach here.
 */
function buildLaunchSpawnArgs({ runtimePath, romPath }) {
  if (typeof runtimePath !== "string" || runtimePath.length === 0) {
    throw new ArchiveBayError("ARCHIVE_BAY_RUNTIME_NOT_CONFIGURED");
  }
  if (typeof romPath !== "string" || romPath.length === 0) {
    throw new ArchiveBayError("ARCHIVE_BAY_TITLE_NOT_FOUND");
  }
  return { command: runtimePath, args: [romPath], options: { shell: false } };
}

module.exports = {
  LEGACY_RUNTIME_KINDS,
  ALLOWED_ROM_EXTENSIONS,
  MAX_LABEL_LENGTH,
  MAX_LIBRARY_ENTRIES,
  ArchiveBayError,
  isLegacyRuntimeKind,
  hasAllowedExtension,
  sha256File,
  canonicalizeImportPath,
  canonicalizeRuntimePath,
  buildLegacyTitleRecord,
  toPublicLegacyTitle,
  emptyLibrary,
  parseLibraryFile,
  serializeLibraryFile,
  loadLibrary,
  saveLibrary,
  buildLaunchSpawnArgs,
};
