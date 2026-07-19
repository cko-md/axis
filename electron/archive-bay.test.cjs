/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  ArchiveBayError,
  buildLaunchSpawnArgs,
  buildLegacyTitleRecord,
  canonicalizeImportPath,
  canonicalizeRuntimePath,
  emptyLibrary,
  hasAllowedExtension,
  isLegacyRuntimeKind,
  loadLibrary,
  parseLibraryFile,
  saveLibrary,
  serializeLibraryFile,
  sha256File,
  toPublicLegacyTitle,
} = require("./archive-bay.cjs");

const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const VALID_SHA256 = "a".repeat(64);

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "axis-archive-bay-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("recognizes the fixed LegacyRuntimeKind domain", () => {
  assert.equal(isLegacyRuntimeKind("external-emulator"), true);
  assert.equal(isLegacyRuntimeKind("managed-emulator"), true);
  assert.equal(isLegacyRuntimeKind("native-recomp"), true);
  assert.equal(isLegacyRuntimeKind("emulator"), false);
  assert.equal(isLegacyRuntimeKind(""), false);
});

test("only .nds is an allowed ROM extension by default", () => {
  assert.equal(hasAllowedExtension("/roms/game.nds"), true);
  assert.equal(hasAllowedExtension("/roms/GAME.NDS"), true);
  assert.equal(hasAllowedExtension("/roms/game.exe"), false);
  assert.equal(hasAllowedExtension("/roms/game.nds.exe"), false);
});

test("sha256File hashes real file bytes deterministically", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "sample.nds");
    await fs.writeFile(file, "axis-archive-bay-fixture");
    const first = await sha256File(file);
    const second = await sha256File(file);
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  });
});

test("canonicalizeImportPath accepts a real .nds file and rejects everything else", async () => {
  await withTempDir(async (dir) => {
    const romFile = path.join(dir, "game.nds");
    await fs.writeFile(romFile, "rom-bytes");
    const resolved = await canonicalizeImportPath(romFile);
    assert.equal(resolved, await fs.realpath(romFile));

    const wrongExtension = path.join(dir, "game.txt");
    await fs.writeFile(wrongExtension, "not a rom");
    await assert.rejects(
      () => canonicalizeImportPath(wrongExtension),
      (error) => error instanceof ArchiveBayError && error.code === "ARCHIVE_BAY_EXTENSION_NOT_ALLOWED",
    );

    await assert.rejects(
      () => canonicalizeImportPath(path.join(dir, "does-not-exist.nds")),
      (error) => error instanceof ArchiveBayError && error.code === "ARCHIVE_BAY_PATH_UNREADABLE",
    );

    const directory = path.join(dir, "a-directory.nds");
    await fs.mkdir(directory);
    await assert.rejects(
      () => canonicalizeImportPath(directory),
      (error) => error instanceof ArchiveBayError && error.code === "ARCHIVE_BAY_PATH_NOT_A_FILE",
    );

    await assert.rejects(
      () => canonicalizeImportPath(""),
      (error) => error instanceof ArchiveBayError && error.code === "ARCHIVE_BAY_PATH_INVALID",
    );
  });
});

test("canonicalizeImportPath resolves a symlink to its real target before validating", async () => {
  await withTempDir(async (dir) => {
    const realRom = path.join(dir, "real.nds");
    await fs.writeFile(realRom, "rom-bytes");
    const link = path.join(dir, "link.nds");
    await fs.symlink(realRom, link);
    const resolved = await canonicalizeImportPath(link);
    assert.equal(resolved, await fs.realpath(realRom));

    // A symlink whose real target has a disallowed extension must still be
    // rejected — the extension check runs against the resolved path, not
    // the link's own name.
    const disallowedTarget = path.join(dir, "real.txt");
    await fs.writeFile(disallowedTarget, "not a rom");
    const trickLink = path.join(dir, "trick.nds");
    await fs.symlink(disallowedTarget, trickLink);
    await assert.rejects(
      () => canonicalizeImportPath(trickLink),
      (error) => error instanceof ArchiveBayError && error.code === "ARCHIVE_BAY_EXTENSION_NOT_ALLOWED",
    );
  });
});

test("canonicalizeRuntimePath accepts any real file (no extension allowlist) but rejects missing/non-file paths", async () => {
  await withTempDir(async (dir) => {
    const executable = path.join(dir, "melonDS");
    await fs.writeFile(executable, "#!/bin/sh\n");
    const resolved = await canonicalizeRuntimePath(executable);
    assert.equal(resolved, await fs.realpath(executable));

    await assert.rejects(
      () => canonicalizeRuntimePath(path.join(dir, "missing")),
      (error) => error instanceof ArchiveBayError && error.code === "ARCHIVE_BAY_PATH_UNREADABLE",
    );
  });
});

test("buildLegacyTitleRecord validates every field and rejects malformed input", () => {
  const now = new Date().toISOString();
  const record = buildLegacyTitleRecord({
    contentId: CONTENT_ID,
    label: "  My Game  ",
    runtimeKind: "external-emulator",
    sha256: VALID_SHA256,
    addedAt: now,
  });
  assert.equal(record.label, "My Game");
  assert.equal(record.contentId, CONTENT_ID);

  assert.throws(
    () => buildLegacyTitleRecord({ contentId: "not-a-uuid", runtimeKind: "external-emulator", sha256: VALID_SHA256, addedAt: now }),
    (error) => error.code === "ARCHIVE_BAY_CONTENT_ID_INVALID",
  );
  assert.throws(
    () => buildLegacyTitleRecord({ contentId: CONTENT_ID, runtimeKind: "not-a-kind", sha256: VALID_SHA256, addedAt: now }),
    (error) => error.code === "ARCHIVE_BAY_RUNTIME_KIND_INVALID",
  );
  assert.throws(
    () => buildLegacyTitleRecord({ contentId: CONTENT_ID, runtimeKind: "external-emulator", sha256: "not-hex", addedAt: now }),
    (error) => error.code === "ARCHIVE_BAY_SHA256_INVALID",
  );
  assert.throws(
    () => buildLegacyTitleRecord({ contentId: CONTENT_ID, runtimeKind: "external-emulator", sha256: VALID_SHA256, addedAt: "not-a-date" }),
    (error) => error.code === "ARCHIVE_BAY_TIMESTAMP_INVALID",
  );
});

test("buildLegacyTitleRecord falls back to an honest default label", () => {
  const record = buildLegacyTitleRecord({
    contentId: CONTENT_ID,
    label: "   ",
    runtimeKind: "external-emulator",
    sha256: VALID_SHA256,
    addedAt: new Date().toISOString(),
  });
  assert.equal(record.label, "Untitled import");
});

test("toPublicLegacyTitle never leaks a filesystem path", () => {
  const record = {
    contentId: CONTENT_ID,
    label: "My Game",
    runtimeKind: "external-emulator",
    sha256: VALID_SHA256,
    addedAt: new Date().toISOString(),
    romPath: "/Users/someone/Roms/secret-game.nds",
  };
  const publicView = toPublicLegacyTitle(record);
  assert.deepEqual(Object.keys(publicView).sort(), ["addedAt", "contentId", "label", "runtimeKind"]);
  assert.equal(JSON.stringify(publicView).includes("secret-game"), false);
});

test("parseLibraryFile round-trips through serializeLibraryFile", () => {
  const library = emptyLibrary();
  library.runtimePath = "/opt/melonDS/melonDS";
  const record = buildLegacyTitleRecord({
    contentId: CONTENT_ID,
    label: "My Game",
    runtimeKind: "external-emulator",
    sha256: VALID_SHA256,
    addedAt: new Date().toISOString(),
  });
  library.titles.set(CONTENT_ID, { ...record, romPath: "/Users/someone/Roms/game.nds" });

  const serialized = serializeLibraryFile(library);
  const reparsed = parseLibraryFile(serialized);
  assert.equal(reparsed.runtimePath, library.runtimePath);
  assert.equal(reparsed.titles.size, 1);
  assert.deepEqual(reparsed.titles.get(CONTENT_ID), library.titles.get(CONTENT_ID));
});

test("parseLibraryFile rejects malformed, oversized, and duplicate-keyed input", () => {
  assert.throws(() => parseLibraryFile("not json"), (error) => error.code === "ARCHIVE_BAY_LIBRARY_CORRUPT");
  assert.throws(
    () => parseLibraryFile(JSON.stringify({ schemaVersion: 2, titles: [] })),
    (error) => error.code === "ARCHIVE_BAY_LIBRARY_CORRUPT",
  );
  assert.throws(
    () => parseLibraryFile(JSON.stringify({ schemaVersion: 1, titles: "not-an-array" })),
    (error) => error.code === "ARCHIVE_BAY_LIBRARY_CORRUPT",
  );
  assert.throws(
    () => parseLibraryFile(JSON.stringify({
      schemaVersion: 1,
      titles: Array.from({ length: 501 }, (_, index) => ({
        contentId: CONTENT_ID,
        label: `title-${index}`,
        runtimeKind: "external-emulator",
        sha256: VALID_SHA256,
        addedAt: new Date().toISOString(),
        romPath: "/roms/game.nds",
      })),
    })),
    (error) => error.code === "ARCHIVE_BAY_LIBRARY_TOO_LARGE",
  );
  const duplicateTitle = {
    contentId: CONTENT_ID,
    label: "dup",
    runtimeKind: "external-emulator",
    sha256: VALID_SHA256,
    addedAt: new Date().toISOString(),
    romPath: "/roms/game.nds",
  };
  assert.throws(
    () => parseLibraryFile(JSON.stringify({ schemaVersion: 1, titles: [duplicateTitle, duplicateTitle] })),
    (error) => error.code === "ARCHIVE_BAY_LIBRARY_CORRUPT",
  );
  assert.throws(
    () => parseLibraryFile(JSON.stringify({ schemaVersion: 1, titles: [{ ...duplicateTitle, romPath: undefined }] })),
    (error) => error.code === "ARCHIVE_BAY_LIBRARY_CORRUPT",
  );
});

test("loadLibrary returns an empty library when the file does not exist yet", async () => {
  await withTempDir(async (dir) => {
    const library = await loadLibrary(path.join(dir, "does-not-exist", "library.json"));
    assert.equal(library.titles.size, 0);
    assert.equal(library.runtimePath, null);
  });
});

test("saveLibrary writes atomically and loadLibrary reads it back", async () => {
  await withTempDir(async (dir) => {
    const libraryPath = path.join(dir, "nested", "library.json");
    const library = emptyLibrary();
    library.runtimePath = "/opt/melonDS/melonDS";
    const record = buildLegacyTitleRecord({
      contentId: CONTENT_ID,
      label: "My Game",
      runtimeKind: "external-emulator",
      sha256: VALID_SHA256,
      addedAt: new Date().toISOString(),
    });
    library.titles.set(CONTENT_ID, { ...record, romPath: "/roms/game.nds" });

    await saveLibrary(libraryPath, library);
    const reloaded = await loadLibrary(libraryPath);
    assert.equal(reloaded.runtimePath, library.runtimePath);
    assert.deepEqual(reloaded.titles.get(CONTENT_ID), library.titles.get(CONTENT_ID));

    // No stray temp files should survive a successful save.
    const entries = await fs.readdir(path.join(dir, "nested"));
    assert.deepEqual(entries, ["library.json"]);
  });
});

test("buildLaunchSpawnArgs is the entire child-process contract: two fixed args, shell disabled", () => {
  const spawnArgs = buildLaunchSpawnArgs({
    runtimePath: "/opt/melonDS/melonDS",
    romPath: "/Users/someone/Roms/game.nds",
  });
  assert.deepEqual(spawnArgs, {
    command: "/opt/melonDS/melonDS",
    args: ["/Users/someone/Roms/game.nds"],
    options: { shell: false },
  });
  // No hidden third argument, no options beyond shell:false.
  assert.deepEqual(Object.keys(spawnArgs.options), ["shell"]);
  assert.equal(spawnArgs.args.length, 1);
});

test("buildLaunchSpawnArgs refuses to launch without a configured runtime or a resolved title", () => {
  assert.throws(
    () => buildLaunchSpawnArgs({ runtimePath: "", romPath: "/roms/game.nds" }),
    (error) => error.code === "ARCHIVE_BAY_RUNTIME_NOT_CONFIGURED",
  );
  assert.throws(
    () => buildLaunchSpawnArgs({ runtimePath: "/opt/melonDS/melonDS", romPath: "" }),
    (error) => error.code === "ARCHIVE_BAY_TITLE_NOT_FOUND",
  );
});
