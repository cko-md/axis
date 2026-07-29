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
const MAX_ARCHITECTURES = 64;
const FAT_HEADER_SIZE = 8;
const FAT_ARCH_SIZE = 20;
const FAT_ARCH_64_SIZE = 32;

const MACHO_THIN_MAGICS = new Map([
  [0xfeedface, { byteOrder: "be", headerSize: 28 }],
  [0xcefaedfe, { byteOrder: "le", headerSize: 28 }],
  [0xfeedfacf, { byteOrder: "be", headerSize: 32 }],
  [0xcffaedfe, { byteOrder: "le", headerSize: 32 }],
]);
const FAT_MAGICS = new Map([
  [0xcafebabe, { byteOrder: "be", entrySize: FAT_ARCH_SIZE, name: "fat Mach-O" }],
  [0xbebafeca, { byteOrder: "le", entrySize: FAT_ARCH_SIZE, name: "fat Mach-O" }],
  [0xcafebabf, { byteOrder: "be", entrySize: FAT_ARCH_64_SIZE, name: "fat64 Mach-O" }],
  [0xbfbafeca, { byteOrder: "le", entrySize: FAT_ARCH_64_SIZE, name: "fat64 Mach-O" }],
]);
const MACHO_ARCHITECTURES = new Map([
  ["16777223:3", "x86_64"],
  ["16777228:0", "arm64"],
]);
const MACHO_FILE_TYPES = new Set([2, 6]); // MH_EXECUTE and MH_DYLIB (Electron Framework).
const PE_MACHINES = new Map([
  [0x014c, 0x010b], // x86 PE32
  [0x8664, 0x020b], // x86_64 PE32+
  [0xaa64, 0x020b], // arm64 PE32+
]);
const ELF_MACHINES = new Map([
  [3, 1], // x86 ELF32
  [40, 1], // ARM ELF32
  [62, 2], // x86_64 ELF64
  [183, 2], // AArch64 ELF64
]);

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

async function readExactly(handle, length, position, description) {
  const bytes = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`Truncated ${description} at byte ${position}`);
  }
  return bytes;
}

function readUInt32(buffer, offset, byteOrder) {
  return byteOrder === "be" ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
}

function readInt32(buffer, offset, byteOrder) {
  return byteOrder === "be" ? buffer.readInt32BE(offset) : buffer.readInt32LE(offset);
}

function readBigUInt64(buffer, offset, byteOrder) {
  return byteOrder === "be" ? buffer.readBigUInt64BE(offset) : buffer.readBigUInt64LE(offset);
}

function wholeFileArchitecture(format, size) {
  return {
    format,
    architectures: [{ end: size, start: 0 }],
  };
}

function architectureTuple(cpuType, cpuSubtype) {
  return `${cpuType}:${cpuSubtype}`;
}

async function readThinMachOArchitecture(handle, start, end, expectedTuple) {
  const magic = await readExactly(handle, 4, start, "thin Mach-O header");
  const descriptor = MACHO_THIN_MAGICS.get(magic.readUInt32BE(0));
  if (!descriptor || start + descriptor.headerSize > end) {
    throw new Error(`Thin Mach-O architecture header at byte ${start} is invalid or truncated`);
  }
  const header = await readExactly(handle, descriptor.headerSize, start, "thin Mach-O header");
  const cpuType = readInt32(header, 4, descriptor.byteOrder);
  const cpuSubtype = readInt32(header, 8, descriptor.byteOrder);
  const tuple = architectureTuple(cpuType, cpuSubtype);
  if (!MACHO_ARCHITECTURES.has(tuple)) {
    throw new Error(`Thin Mach-O architecture at byte ${start} has unsupported CPU tuple ${tuple}`);
  }
  if (expectedTuple && tuple !== expectedTuple) {
    throw new Error(
      `Thin Mach-O architecture at byte ${start} (${tuple}) does not match its fat-table tuple ${expectedTuple}`,
    );
  }
  const fileType = readUInt32(header, 12, descriptor.byteOrder);
  const commandCount = readUInt32(header, 16, descriptor.byteOrder);
  const commandBytes = readUInt32(header, 20, descriptor.byteOrder);
  if (
    !MACHO_FILE_TYPES.has(fileType)
    || commandCount === 0
    || commandBytes > end - start - descriptor.headerSize
  ) {
    throw new Error(`Thin Mach-O architecture header at byte ${start} is not a canonical Electron binary`);
  }
  return { cpuSubtype, cpuType, end, start };
}

async function readFatMachOArchitectures(handle, size, descriptor) {
  const header = await readExactly(handle, FAT_HEADER_SIZE, 0, `${descriptor.name} header`);
  const count = readUInt32(header, 4, descriptor.byteOrder);
  if (count === 0 || count > MAX_ARCHITECTURES) {
    throw new Error(
      `${descriptor.name} declares invalid architecture count ${count}; expected 1-${MAX_ARCHITECTURES}`,
    );
  }

  const tableSize = count * descriptor.entrySize;
  const tableEnd = FAT_HEADER_SIZE + tableSize;
  if (!Number.isSafeInteger(tableEnd) || tableEnd > size) {
    throw new Error(`${descriptor.name} architecture table is truncated or malformed`);
  }

  const table = await readExactly(handle, tableSize, FAT_HEADER_SIZE, `${descriptor.name} architecture table`);
  const architectures = [];
  const tuples = new Set();
  const fileSize = BigInt(size);
  const minimumOffset = BigInt(tableEnd);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = index * descriptor.entrySize;
    const cpuType = readInt32(table, entryOffset, descriptor.byteOrder);
    const cpuSubtype = readInt32(table, entryOffset + 4, descriptor.byteOrder);
    const offset = descriptor.entrySize === FAT_ARCH_64_SIZE
      ? readBigUInt64(table, entryOffset + 8, descriptor.byteOrder)
      : BigInt(readUInt32(table, entryOffset + 8, descriptor.byteOrder));
    const length = descriptor.entrySize === FAT_ARCH_64_SIZE
      ? readBigUInt64(table, entryOffset + 16, descriptor.byteOrder)
      : BigInt(readUInt32(table, entryOffset + 12, descriptor.byteOrder));
    const end = offset + length;

    const tuple = architectureTuple(cpuType, cpuSubtype);
    if (
      !MACHO_ARCHITECTURES.has(tuple)
      || tuples.has(tuple)
      || length === 0n
      || offset < minimumOffset
      || end > fileSize
    ) {
      throw new Error(`${descriptor.name} architecture slice ${index + 1}/${count} is malformed`);
    }
    tuples.add(tuple);
    architectures.push(await readThinMachOArchitecture(
      handle,
      Number(offset),
      Number(end),
      tuple,
    ));
  }

  const sorted = [...architectures].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].end > sorted[index].start) {
      throw new Error(`${descriptor.name} architecture slices overlap and are ambiguous`);
    }
  }

  return { architectures: sorted, format: descriptor.name };
}

async function readPortableExecutableArchitecture(handle, size) {
  if (size < 64) throw new Error("PE executable is truncated before its DOS header");
  const dosHeader = await readExactly(handle, 64, 0, "PE DOS header");
  const peOffset = dosHeader.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 > size) {
    throw new Error("PE executable has an invalid or truncated COFF header offset");
  }
  const coffHeader = await readExactly(handle, 24, peOffset, "PE COFF header");
  if (!coffHeader.subarray(0, 4).equals(Buffer.from("PE\0\0"))) {
    throw new Error("PE executable is missing its COFF signature");
  }
  const machine = coffHeader.readUInt16LE(4);
  const sectionCount = coffHeader.readUInt16LE(6);
  const optionalHeaderSize = coffHeader.readUInt16LE(20);
  const expectedOptionalMagic = PE_MACHINES.get(machine);
  if (!expectedOptionalMagic || sectionCount === 0 || optionalHeaderSize < 2 || peOffset + 24 + optionalHeaderSize > size) {
    throw new Error("PE executable has an unknown machine architecture");
  }
  const optionalHeader = await readExactly(handle, 2, peOffset + 24, "PE optional header");
  if (optionalHeader.readUInt16LE(0) !== expectedOptionalMagic) {
    throw new Error("PE executable has a non-canonical optional header");
  }
  return wholeFileArchitecture("PE", size);
}

async function readElfArchitecture(handle, size) {
  if (size < 24) throw new Error("ELF executable is truncated before its header");
  const ident = await readExactly(handle, 24, 0, "ELF header");
  const elfClass = ident[4];
  const byteOrder = ident[5];
  const headerSize = elfClass === 1 ? 52 : elfClass === 2 ? 64 : 0;
  if (headerSize === 0 || byteOrder !== 1 || ident[6] !== 1 || size < headerSize) {
    throw new Error("ELF executable has an unknown or truncated architecture header");
  }
  const machine = ident.readUInt16LE(18);
  const fileType = ident.readUInt16LE(16);
  const version = ident.readUInt32LE(20);
  if (ELF_MACHINES.get(machine) !== elfClass || (fileType !== 2 && fileType !== 3) || version !== 1) {
    throw new Error("ELF executable has an unknown or non-canonical machine architecture");
  }
  return wholeFileArchitecture("ELF", size);
}

async function readExecutableArchitectures(handle) {
  const { size } = await handle.stat();
  if (!Number.isSafeInteger(size) || size < 4) {
    throw new Error("Executable is empty, truncated, or too large to verify safely");
  }
  const magic = await readExactly(handle, 4, 0, "executable header");
  const magicBe = magic.readUInt32BE(0);
  if (MACHO_THIN_MAGICS.has(magicBe)) {
    return {
      architectures: [await readThinMachOArchitecture(handle, 0, size)],
      format: "thin Mach-O",
    };
  }
  const fatDescriptor = FAT_MAGICS.get(magicBe);
  if (fatDescriptor) return readFatMachOArchitectures(handle, size, fatDescriptor);
  if (magic.subarray(0, 2).equals(Buffer.from("MZ"))) {
    return readPortableExecutableArchitecture(handle, size);
  }
  if (magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return readElfArchitecture(handle, size);
  throw new Error("Unsupported or ambiguous executable format; refusing to infer architecture count");
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
    const executable = await readExecutableArchitectures(handle);
    const offsets = await findSentinelOffsets(handle);
    if (offsets.length === 0) {
      throw new Error(`No Electron fuse sentinel found in ${fuseFile}`);
    }
    if (offsets.length !== executable.architectures.length) {
      throw new Error(
        `Found ${offsets.length} fuse wires in ${fuseFile}, but ${executable.format} declares ${executable.architectures.length} architecture slice(s)`,
      );
    }

    const wiresByArchitecture = new Map();
    for (const offset of offsets) {
      const wire = await readWireAt(handle, offset);
      const wireEnd = wire.offset + SENTINEL.length + 2 + wire.states.length;
      const architectureIndex = executable.architectures.findIndex(
        (architecture) => wire.offset >= architecture.start && wireEnd <= architecture.end,
      );
      if (architectureIndex === -1) {
        throw new Error(`Fuse wire at byte ${wire.offset} is not contained in a declared architecture slice`);
      }
      if (wiresByArchitecture.has(architectureIndex)) {
        throw new Error(`Architecture slice ${architectureIndex + 1} contains more than one fuse wire`);
      }
      wiresByArchitecture.set(architectureIndex, { ...wire, architectureIndex });
    }
    if (wiresByArchitecture.size !== executable.architectures.length) {
      throw new Error("Every declared architecture slice must contain exactly one Electron fuse wire");
    }
    return {
      architectureCount: executable.architectures.length,
      fuseFile,
      wires: [...wiresByArchitecture.values()].sort(
        (left, right) => left.architectureIndex - right.architectureIndex,
      ),
    };
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
