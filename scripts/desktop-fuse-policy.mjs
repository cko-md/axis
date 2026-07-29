import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  pathToFuseFile,
} from "@electron/fuses";

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const SCAN_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_WIRE_LENGTH = 255;

export const REQUIRED_FUSES = Object.freeze([
  { index: FuseV1Options.RunAsNode, name: "RunAsNode", enabled: false },
  { index: FuseV1Options.EnableCookieEncryption, name: "EnableCookieEncryption", enabled: true },
  {
    index: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    name: "EnableNodeOptionsEnvironmentVariable",
    enabled: false,
  },
  {
    index: FuseV1Options.EnableNodeCliInspectArguments,
    name: "EnableNodeCliInspectArguments",
    enabled: false,
  },
  {
    index: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    name: "EnableEmbeddedAsarIntegrityValidation",
    enabled: true,
  },
  { index: FuseV1Options.OnlyLoadAppFromAsar, name: "OnlyLoadAppFromAsar", enabled: true },
  {
    index: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    name: "LoadBrowserProcessSpecificV8Snapshot",
    enabled: false,
  },
  {
    index: FuseV1Options.GrantFileProtocolExtraPrivileges,
    name: "GrantFileProtocolExtraPrivileges",
    enabled: false,
  },
  { index: FuseV1Options.WasmTrapHandlers, name: "WasmTrapHandlers", enabled: true },
]);

function expectedState(enabled) {
  return enabled ? FuseState.ENABLE : FuseState.DISABLE;
}

export function fuseStateName(state) {
  switch (state) {
    case FuseState.ENABLE:
      return "ENABLE";
    case FuseState.DISABLE:
      return "DISABLE";
    case FuseState.REMOVED:
      return "REMOVED";
    case FuseState.INHERIT:
      return "INHERIT";
    default:
      return `UNKNOWN(0x${Number(state).toString(16).padStart(2, "0")})`;
  }
}

export function validateFuseWire(wire) {
  const problems = [];
  if (wire.version !== Number(FuseVersion.V1)) {
    problems.push(`version: expected ${FuseVersion.V1}, artifact has ${wire.version}`);
  }
  if (wire.states.length !== REQUIRED_FUSES.length) {
    problems.push(
      `wire length: expected exactly ${REQUIRED_FUSES.length}, artifact has ${wire.states.length}`,
    );
  }

  for (const requirement of REQUIRED_FUSES) {
    const actual = wire.states[requirement.index];
    if (actual === undefined) {
      problems.push(`${requirement.name}: missing from fuse wire`);
      continue;
    }
    const expected = expectedState(requirement.enabled);
    if (actual !== expected) {
      problems.push(
        `${requirement.name}: expected ${fuseStateName(expected)}, artifact has ${fuseStateName(actual)}`,
      );
    }
  }
  return problems;
}

async function findSentinelOffsets(handle) {
  const { size } = await handle.stat();
  const overlapLength = SENTINEL.length - 1;
  const offsets = new Set();
  let carry = Buffer.alloc(0);

  for (let position = 0; position < size; position += SCAN_CHUNK_SIZE) {
    const chunkLength = Math.min(SCAN_CHUNK_SIZE, size - position);
    const chunk = Buffer.allocUnsafe(chunkLength);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    const bytes = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
    const bytesStart = position - carry.length;

    let offset = bytes.indexOf(SENTINEL);
    while (offset !== -1) {
      offsets.add(bytesStart + offset);
      offset = bytes.indexOf(SENTINEL, offset + 1);
    }
    carry = bytes.subarray(Math.max(0, bytes.length - overlapLength));
  }
  return [...offsets].sort((left, right) => left - right);
}

async function readWireAt(handle, sentinelOffset) {
  const header = Buffer.allocUnsafe(2);
  const headerPosition = sentinelOffset + SENTINEL.length;
  const headerRead = await handle.read(header, 0, header.length, headerPosition);
  if (headerRead.bytesRead !== header.length) {
    throw new Error(`Truncated fuse header at byte ${sentinelOffset}`);
  }

  const version = header[0];
  const wireLength = header[1];
  if (wireLength > MAX_WIRE_LENGTH) {
    throw new Error(`Invalid fuse wire length ${wireLength} at byte ${sentinelOffset}`);
  }

  const states = Buffer.allocUnsafe(wireLength);
  const wireRead = await handle.read(states, 0, states.length, headerPosition + header.length);
  if (wireRead.bytesRead !== states.length) {
    throw new Error(`Truncated fuse wire at byte ${sentinelOffset}`);
  }
  return { offset: sentinelOffset, states: [...states], version };
}

export async function readAllFuseWires(target) {
  const fuseFile = pathToFuseFile(target);
  const handle = await open(fuseFile, "r");
  try {
    const offsets = await findSentinelOffsets(handle);
    if (offsets.length === 0) {
      throw new Error(`No Electron fuse sentinel found in ${fuseFile}`);
    }
    if (offsets.length > 2) {
      throw new Error(
        `Found ${offsets.length} fuse wires in ${fuseFile}; expected at most two architecture slices`,
      );
    }
    const wires = [];
    for (const offset of offsets) {
      wires.push(await readWireAt(handle, offset));
    }
    return { fuseFile, wires };
  } finally {
    await handle.close();
  }
}

function isMacApp(directory) {
  return path.extname(directory).toLowerCase() === ".app";
}

function isUnpackedExecutable(file) {
  const basename = path.basename(file).toLowerCase();
  const parent = path.basename(path.dirname(file)).toLowerCase();
  return (
    (basename === "axis.exe" || basename === "axis") &&
    (parent.endsWith("-unpacked") || parent.startsWith("linux-"))
  );
}

async function walkPackagedTargets(directory, targets) {
  if (isMacApp(directory)) {
    targets.add(path.resolve(directory));
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkPackagedTargets(full, targets);
    } else if (entry.isFile() && isUnpackedExecutable(full)) {
      targets.add(path.resolve(full));
    }
  }
}

export async function discoverPackagedTargets(input) {
  const resolved = path.resolve(input);
  const info = await stat(resolved);
  if (info.isFile() || isMacApp(resolved)) return [resolved];
  if (!info.isDirectory()) throw new Error(`Unsupported packaged target: ${resolved}`);

  const targets = new Set();
  await walkPackagedTargets(resolved, targets);
  return [...targets].sort();
}

export async function verifyFuseTarget(target) {
  const result = await readAllFuseWires(target);
  const problems = [];
  for (const [index, wire] of result.wires.entries()) {
    for (const problem of validateFuseWire(wire)) {
      problems.push(`slice ${index + 1}/${result.wires.length}: ${problem}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Electron fuse verification FAILED for ${target}:\n${problems.map((item) => `  ✗ ${item}`).join("\n")}`,
    );
  }
  return result;
}
