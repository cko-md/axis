#!/usr/bin/env node
import path from "node:path";
import {
  discoverMacApps,
  verifyMacSignature,
} from "./desktop-signature-policy.mjs";

const args = process.argv.slice(2);
const mode = args.includes("--release") ? "release" : "preview";
const input =
  args.find((argument) => argument !== "--release" && argument !== "--preview") ??
  path.resolve(process.cwd(), "dist-electron");

if (process.platform !== "darwin") {
  console.error("macOS signature verification must run on a Darwin host");
  process.exit(1);
}

let applications;
try {
  applications = await discoverMacApps(input);
} catch (error) {
  console.error(`Could not discover macOS applications under ${input}: ${error.message}`);
  process.exit(1);
}
if (applications.length === 0) {
  console.error(`No macOS app bundles found under ${input}`);
  process.exit(1);
}

for (const application of applications) {
  try {
    verifyMacSignature(application, mode);
    console.log(`✓ ${application}: valid ${mode === "preview" ? "ad-hoc preview" : "Developer ID release"} signature`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

console.log(`✓ ${applications.length} macOS app bundle(s) satisfy the ${mode} signature policy`);
