/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { packagedTarget } = require("./after-pack-fuses.cjs");
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

function writeFatArch(table, entryOffset, cpuType, offset, size) {
  table.writeInt32BE(cpuType, entryOffset);
  table.writeInt32BE(3, entryOffset + 4);
  table.writeUInt32BE(offset, entryOffset + 8);
  table.writeUInt32BE(size, entryOffset + 12);
  table.writeUInt32BE(2, entryOffset + 16);
}

function universalMachO(wires) {
  const sliceOffsets = [0x100, 0x200];
  const sliceSize = 0x100;
  const binary = Buffer.alloc(0x300);
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(2, 4);
  // x86_64 and arm64: this is a real two-slice universal-Mach-O table shape.
  writeFatArch(binary, 8, 0x01000007, sliceOffsets[0], sliceSize);
  writeFatArch(binary, 28, 0x0100000c, sliceOffsets[1], sliceSize);
  for (const [index, wire] of wires.entries()) wire.copy(binary, sliceOffsets[index]);
  return binary;
}

function thinMachO(wire) {
  const binary = Buffer.alloc(0x100);
  binary.writeUInt32BE(0xfeedfacf, 0);
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
  wire.copy(binary, 0x100);
  return binary;
}

function portableExecutable(wire) {
  const binary = Buffer.alloc(0x200);
  binary.write("MZ", 0);
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write("PE\0\0", 0x80);
  binary.writeUInt16LE(0x8664, 0x84);
  wire.copy(binary, 0x100);
  return binary;
}

function elfExecutable(wire) {
  const binary = Buffer.alloc(0x100);
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  binary.writeUInt16LE(0x3e, 18);
  wire.copy(binary, 0x40);
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
