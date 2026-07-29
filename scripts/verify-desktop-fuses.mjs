#!/usr/bin/env node
/**
 * Verify every Electron fuse wire in every unpacked packaged artifact.
 *
 * A universal macOS binary contains one wire per architecture. A multi-arch
 * electron-builder run can also leave several app directories. Discovery and
 * verification therefore deliberately cover all targets and all slices.
 */
import path from "node:path";
import {
  discoverPackagedTargets,
  REQUIRED_FUSES,
  verifyFuseTarget,
} from "./desktop-fuse-policy.mjs";

const input = process.argv[2] ?? path.resolve(process.cwd(), "dist-electron");

let targets;
try {
  targets = await discoverPackagedTargets(input);
} catch (error) {
  console.error(`Could not discover packaged applications under ${input}: ${error.message}`);
  process.exit(1);
}

if (targets.length === 0) {
  console.error(
    `No unpacked packaged application found under ${input}. Build first or pass an app/binary path.`,
  );
  process.exit(1);
}

let slices = 0;
for (const target of targets) {
  try {
    const result = await verifyFuseTarget(target);
    slices += result.wires.length;
    console.log(`✓ ${target}: ${result.wires.length} fuse wire(s) verified`);
  } catch (error) {
    console.error(error.message);
    console.error("\nThe packaged binary is not hardened as configured. Do not ship it.");
    process.exit(1);
  }
}

console.log(
  `✓ All ${REQUIRED_FUSES.length} required Electron fuses verified across ${targets.length} artifact(s), ${slices} architecture slice(s)`,
);
