/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { packagedTarget } = require("./after-pack-fuses.cjs");
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

function writeFatArch(table, entryOffset, cpuType, cpuSubtype, offset, size) {
  table.writeInt32BE(cpuType, entryOffset);
  table.writeInt32BE(cpuSubtype, entryOffset + 4);
  table.writeUInt32BE(offset, entryOffset + 8);
  table.writeUInt32BE(size, entryOffset + 12);
  table.writeUInt32BE(2, entryOffset + 16);
}

function writeThinMachOHeader(binary, offset, cpuType, cpuSubtype, fileType = 2) {
  binary.writeUInt32LE(0xfeedfacf, offset);
  binary.writeInt32LE(cpuType, offset + 4);
  binary.writeInt32LE(cpuSubtype, offset + 8);
  binary.writeUInt32LE(fileType, offset + 12);
  binary.writeUInt32LE(1, offset + 16);
  binary.writeUInt32LE(8, offset + 20);
  binary.writeUInt32LE(0, offset + 24);
  binary.writeUInt32LE(0, offset + 28);
  binary.writeUInt32LE(1, offset + 32);
  binary.writeUInt32LE(8, offset + 36);
}

function universalMachO(wires) {
  const sliceOffsets = [0x100, 0x200];
  const sliceSize = 0x100;
  const binary = Buffer.alloc(0x300);
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(2, 4);
  // x86_64 and arm64: this is a real two-slice universal-Mach-O table shape.
  writeFatArch(binary, 8, 0x01000007, 3, sliceOffsets[0], sliceSize);
  writeFatArch(binary, 28, 0x0100000c, 0, sliceOffsets[1], sliceSize);
  writeThinMachOHeader(binary, sliceOffsets[0], 0x01000007, 3);
  writeThinMachOHeader(binary, sliceOffsets[1], 0x0100000c, 0);
  for (const [index, wire] of wires.entries()) wire.copy(binary, sliceOffsets[index] + 0x40);
  return binary;
}

function thinMachO(wire) {
  const binary = Buffer.alloc(0x100);
  writeThinMachOHeader(binary, 0, 0x0100000c, 0, 6);
  wire.copy(binary, 0x40);
  return binary;
}

function fat64MachO(wire) {
  const binary = Buffer.alloc(0x200);
  binary.writeUInt32BE(0xcafebabf, 0);
  binary.writeUInt32BE(1, 4);
  binary.writeInt32BE(0x0100000c, 8);
  binary.writeInt32BE(0, 12);
  binary.writeBigUInt64BE(0x100n, 16);
  binary.writeBigUInt64BE(0x100n, 24);
  binary.writeUInt32BE(2, 32);
  binary.writeUInt32BE(0, 36);
  writeThinMachOHeader(binary, 0x100, 0x0100000c, 0);
  wire.copy(binary, 0x140);
  return binary;
}

function portableExecutable(wire) {
  const binary = Buffer.alloc(0x280);
  binary.write("MZ", 0);
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write("PE\0\0", 0x80);
  binary.writeUInt16LE(0x8664, 0x84);
  binary.writeUInt16LE(1, 0x86);
  binary.writeUInt16LE(0xf0, 0x94);
  binary.writeUInt16LE(0x20b, 0x98);
  wire.copy(binary, 0x1c0);
  return binary;
}

function elfExecutable(wire) {
  const binary = Buffer.alloc(0x180);
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  binary.writeUInt16LE(3, 16);
  binary.writeUInt16LE(0x3e, 18);
  binary.writeUInt32LE(1, 20);
  binary.writeBigUInt64LE(0x40n, 32);
  binary.writeUInt16LE(64, 52);
  binary.writeUInt16LE(56, 54);
  binary.writeUInt16LE(1, 56);
  wire.copy(binary, 0x100);
  return binary;
}

async function policy() {
  return import("../scripts/desktop-fuse-policy.mjs");
}

test("the exact Electron fuse enum states are enforced without boolean coercion", async () => {
  const {
    REQUIRED_FUSES,
    validateFuseWire,
  } = await policy();
  const { FuseState } = await import("@electron/fuses");
  const states = REQUIRED_FUSES.map((item) =>
    item.enabled ? FuseState.ENABLE : FuseState.DISABLE,
  );

  assert.deepEqual(validateFuseWire({ version: 1, states }), []);

  for (const ambiguous of [FuseState.REMOVED, FuseState.INHERIT]) {
    const changed = [...states];
    changed[0] = ambiguous;
    assert.match(validateFuseWire({ version: 1, states: changed }).join("\n"), /RunAsNode/);
  }

  const unknown = [...states];
  unknown[1] = 1;
  assert.match(
    validateFuseWire({ version: 1, states: unknown }).join("\n"),
    /EnableCookieEncryption.*UNKNOWN\(0x01\)/,
  );
});

test("missing and extra fuse bytes fail closed", async () => {
  const { REQUIRED_FUSES, validateFuseWire } = await policy();
  const { FuseState } = await import("@electron/fuses");
  const states = REQUIRED_FUSES.map((item) =>
    item.enabled ? FuseState.ENABLE : FuseState.DISABLE,
  );

  assert.match(
    validateFuseWire({ version: 1, states: states.slice(0, -1) }).join("\n"),
    /wire length.*8.*WasmTrapHandlers.*missing/s,
  );
  assert.match(
    validateFuseWire({ version: 1, states: [...states, FuseState.DISABLE] }).join("\n"),
    /wire length.*10/,
  );
});

test("every x86_64 and arm64 universal-Mach-O slice has one verified fuse wire", async (t) => {
  const {
    REQUIRED_FUSES,
    readAllFuseWires,
    verifyFuseTarget,
  } = await policy();
  const { FuseState } = await import("@electron/fuses");
  const states = Buffer.from(
    REQUIRED_FUSES.map((item) => item.enabled ? FuseState.ENABLE : FuseState.DISABLE),
  );
  const validWire = Buffer.concat([SENTINEL, Buffer.from([1, states.length]), states]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "axis-fuses-"));
  const binary = path.join(directory, "AXIS");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(binary, universalMachO([validWire]));
  await assert.rejects(
    readAllFuseWires(binary),
    /Found 1 fuse wires.*declares 2 architecture slice/s,
  );

  await writeFile(binary, universalMachO([validWire, validWire]));

  const result = await readAllFuseWires(binary);
  assert.equal(result.architectureCount, 2);
  assert.equal(result.wires.length, 2);
  await assert.doesNotReject(verifyFuseTarget(binary));

  const bytes = await readFile(binary);
  bytes[bytes.lastIndexOf(SENTINEL) + SENTINEL.length + 2] = FuseState.INHERIT;
  await writeFile(binary, bytes);
  await assert.rejects(verifyFuseTarget(binary), /slice 2\/2.*RunAsNode.*INHERIT/s);
});

test("thin/fat64 Mach-O and supported PE/ELF executables get an exact one-wire cardinality", async (t) => {
  const { REQUIRED_FUSES, readAllFuseWires } = await policy();
  const { FuseState } = await import("@electron/fuses");
  const states = Buffer.from(
    REQUIRED_FUSES.map((item) => item.enabled ? FuseState.ENABLE : FuseState.DISABLE),
  );
  const wire = Buffer.concat([SENTINEL, Buffer.from([1, states.length]), states]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "axis-fuse-formats-"));
  const binary = path.join(directory, "AXIS");
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const fixture of [thinMachO(wire), fat64MachO(wire), portableExecutable(wire), elfExecutable(wire)]) {
    await writeFile(binary, fixture);
    assert.equal((await readAllFuseWires(binary)).architectureCount, 1);
  }

  await writeFile(binary, Buffer.concat([Buffer.from("not an executable"), wire]));
  await assert.rejects(readAllFuseWires(binary), /Unsupported or ambiguous executable format/);
});

test("malformed architecture headers and unsupported PE/ELF machines fail closed", async (t) => {
  const { REQUIRED_FUSES, readAllFuseWires } = await policy();
  const { FuseState } = await import("@electron/fuses");
  const states = Buffer.from(
    REQUIRED_FUSES.map((item) => item.enabled ? FuseState.ENABLE : FuseState.DISABLE),
  );
  const wire = Buffer.concat([SENTINEL, Buffer.from([1, states.length]), states]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "axis-fuse-rejects-"));
  const binary = path.join(directory, "AXIS");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const badThin = thinMachO(wire);
  badThin.writeInt32LE(0, 4);
  await writeFile(binary, badThin);
  await assert.rejects(readAllFuseWires(binary), /unsupported CPU tuple 0:0/);

  const zeroLoadCommandBytes = thinMachO(wire);
  zeroLoadCommandBytes.writeUInt32LE(0, 20);
  await writeFile(binary, zeroLoadCommandBytes);
  await assert.rejects(readAllFuseWires(binary), /not a canonical Electron binary/);

  const zeroLoadCommandSize = thinMachO(wire);
  zeroLoadCommandSize.writeUInt32LE(0, 36);
  await writeFile(binary, zeroLoadCommandSize);
  await assert.rejects(readAllFuseWires(binary), /invalid load command size/);

  const arm64With32BitMagic = thinMachO(wire);
  arm64With32BitMagic.writeUInt32LE(0xfeedface, 0);
  await writeFile(binary, arm64With32BitMagic);
  await assert.rejects(readAllFuseWires(binary), /must be 64-bit for Electron/);

  const badFatPayload = universalMachO([wire, wire]);
  badFatPayload.writeUInt32LE(0, 0x200);
  await writeFile(binary, badFatPayload);
  await assert.rejects(readAllFuseWires(binary), /Thin Mach-O architecture header.*invalid or truncated/);

  const duplicateFatTuple = universalMachO([wire, wire]);
  writeFatArch(duplicateFatTuple, 28, 0x01000007, 3, 0x200, 0x100);
  writeThinMachOHeader(duplicateFatTuple, 0x200, 0x01000007, 3);
  await writeFile(binary, duplicateFatTuple);
  await assert.rejects(readAllFuseWires(binary), /fat Mach-O architecture slice 2\/2 is malformed/);

  const badPe = portableExecutable(wire);
  badPe.writeUInt16LE(0xffff, 0x84);
  await writeFile(binary, badPe);
  await assert.rejects(readAllFuseWires(binary), /PE executable has an unknown machine architecture/);

  const shortOptionalHeader = portableExecutable(wire);
  shortOptionalHeader.writeUInt16LE(2, 0x94);
  await writeFile(binary, shortOptionalHeader);
  await assert.rejects(readAllFuseWires(binary), /PE executable has an unknown machine architecture/);

  const truncatedOptionalHeader = portableExecutable(wire).subarray(0, 0x100);
  await writeFile(binary, truncatedOptionalHeader);
  await assert.rejects(readAllFuseWires(binary), /PE executable has an unknown machine architecture/);

  const sectionTableOutsideBinary = portableExecutable(wire);
  sectionTableOutsideBinary.writeUInt16LE(0xffff, 0x86);
  await writeFile(binary, sectionTableOutsideBinary);
  await assert.rejects(readAllFuseWires(binary), /PE executable has an unknown machine architecture/);

  const badElfMachine = elfExecutable(wire);
  badElfMachine.writeUInt16LE(0xffff, 18);
  await writeFile(binary, badElfMachine);
  await assert.rejects(readAllFuseWires(binary), /ELF executable has an unknown or non-canonical machine architecture/);

  const badElfVersion = elfExecutable(wire);
  badElfVersion[6] = 0;
  await writeFile(binary, badElfVersion);
  await assert.rejects(readAllFuseWires(binary), /ELF executable has an unknown or truncated architecture header/);

  const badElfHeaderSize = elfExecutable(wire);
  badElfHeaderSize.writeUInt16LE(0, 52);
  await writeFile(binary, badElfHeaderSize);
  await assert.rejects(readAllFuseWires(binary), /ELF executable has non-canonical header or program-header bounds/);
});

test("the direct 2.x afterPack hook is the sole fuse mutation owner", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const builderSource = await readFile(path.join(__dirname, "electron-builder.cjs"), "utf8");
  const hookSource = await readFile(path.join(__dirname, "after-pack-fuses.cjs"), "utf8");

  assert.equal(packageJson.devDependencies["@electron/fuses"], "2.1.3");
  assert.doesNotMatch(builderSource, /\belectronFuses\s*:/);
  assert.match(builderSource, /afterPack:\s*fuseHook/);
  assert.match(builderSource, /"!after-pack-fuses\.cjs"/);
  assert.match(hookSource, /strictlyRequireAllFuses:\s*true/);
  assert.match(hookSource, /\[FuseV1Options\.WasmTrapHandlers\]:\s*true/);
  assert.match(hookSource, /resetAdHocDarwinSignature:/);
});

test("afterPack resolves each platform's exact unpacked application", () => {
  const common = {
    appOutDir: "/tmp/axis-package",
    packager: {
      appInfo: { productFilename: "AXIS" },
      executableName: "axis",
    },
  };
  assert.equal(
    packagedTarget({ ...common, electronPlatformName: "darwin" }),
    "/tmp/axis-package/AXIS.app",
  );
  assert.equal(
    packagedTarget({ ...common, electronPlatformName: "win32" }),
    "/tmp/axis-package/AXIS.exe",
  );
  assert.equal(
    packagedTarget({ ...common, electronPlatformName: "linux" }),
    "/tmp/axis-package/axis",
  );
});
