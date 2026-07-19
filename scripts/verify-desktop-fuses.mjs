#!/usr/bin/env node
/**
 * Read the Electron fuses back out of a PACKAGED artifact.
 *
 * Declaring fuses in electron-builder.cjs proves nothing on its own — if the
 * builder silently ignores the key, or a version bump changes its name, the
 * config still looks correct while the shipped binary is wide open. The only
 * meaningful check is to inspect the artifact, which is what this does.
 *
 *   node scripts/verify-desktop-fuses.mjs [path-to-app]
 *
 * With no argument it discovers the app under dist-electron/ produced by
 * `npm run desktop:dist:dir`. Exits non-zero if any required fuse is missing or
 * set the wrong way.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

// name -> required value. Mirrors electronFuses in electron/electron-builder.cjs.
const REQUIRED = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};

function findPackagedApp(root) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (!statSync(full).isDirectory()) continue;

    // macOS: dist-electron/<something>/AXIS.app/Contents/MacOS/AXIS
    const macBinary = path.join(full, "AXIS.app", "Contents", "MacOS", "AXIS");
    if (existsSync(macBinary)) return macBinary;

    // Linux / Windows unpacked
    for (const candidate of ["AXIS", "AXIS.exe", "axis", "axis.exe"]) {
      const binary = path.join(full, candidate);
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

const explicit = process.argv[2];
const target = explicit ?? findPackagedApp(path.resolve(process.cwd(), "dist-electron"));

if (!target) {
  console.error(
    "No packaged application found. Run `npm run desktop:dist:dir` first, or pass an explicit path.",
  );
  process.exit(1);
}

if (!existsSync(target)) {
  console.error(`No such file: ${target}`);
  process.exit(1);
}

let wire;
try {
  wire = await getCurrentFuseWire(target);
} catch (error) {
  console.error(`Could not read the fuse wire from ${target}: ${error.message}`);
  process.exit(1);
}

const problems = [];
for (const [name, expected] of Object.entries(REQUIRED)) {
  const fuseIndex = FuseV1Options[name];
  if (fuseIndex === undefined) {
    problems.push(`${name}: not a known fuse in the installed @electron/fuses`);
    continue;
  }
  const actual = wire[fuseIndex];
  // The wire stores 1/0 characters; normalise before comparing.
  const actualBool = actual === true || actual === 1 || actual === "1";
  if (actualBool !== expected) {
    problems.push(`${name}: expected ${expected}, artifact has ${actualBool}`);
  }
}

if (problems.length > 0) {
  console.error(`Electron fuse verification FAILED for ${target}:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\nThe packaged binary is not hardened as configured. Do not ship it.");
  process.exit(1);
}

console.log(`✓ All ${Object.keys(REQUIRED).length} required Electron fuses verified in ${target}`);
