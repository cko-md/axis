/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { packagedTarget } = require("./after-pack-fuses.cjs");
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

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

test("every architecture slice in a packaged binary is read and verified", async (t) => {
  const {
    REQUIRED_FUSES,
    readAllFuseWires,
    verifyFuseTarget,
  } = await policy();
  const { FuseState } = await import("@electron/fuses");
  const states = Buffer.from(
    REQUIRED_FUSES.map((item) => item.enabled ? FuseState.ENABLE : FuseState.DISABLE),
  );
  const wire = Buffer.concat([SENTINEL, Buffer.from([1, states.length]), states]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "axis-fuses-"));
  const binary = path.join(directory, "AXIS");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(binary, Buffer.concat([Buffer.from("slice-one"), wire, Buffer.from("slice-two"), wire]));

  const result = await readAllFuseWires(binary);
  assert.equal(result.wires.length, 2);
  await assert.doesNotReject(verifyFuseTarget(binary));

  const bytes = await readFile(binary);
  bytes[bytes.lastIndexOf(SENTINEL) + SENTINEL.length + 2] = FuseState.INHERIT;
  await writeFile(binary, bytes);
  await assert.rejects(verifyFuseTarget(binary), /slice 2\/2.*RunAsNode.*INHERIT/s);
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
