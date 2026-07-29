import { execFileSync, spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export function parseCodesignMetadata(output) {
  const metadata = new Map();
  const authorities = [];
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Authority") authorities.push(value);
    else metadata.set(key, value);
  }
  return {
    authorities,
    signature: metadata.get("Signature"),
    teamIdentifier: metadata.get("TeamIdentifier"),
  };
}

export function validateSignatureMetadata(metadata, mode) {
  const problems = [];
  if (mode === "preview") {
    if (metadata.signature !== "adhoc") {
      problems.push(`expected an ad-hoc signature, found ${metadata.signature ?? "none"}`);
    }
    if (metadata.teamIdentifier !== "not set") {
      problems.push(`preview must not carry a signing team, found ${metadata.teamIdentifier ?? "none"}`);
    }
    if (metadata.authorities.length > 0) {
      problems.push(`preview must not carry certificate authorities: ${metadata.authorities.join(", ")}`);
    }
  } else if (mode === "release") {
    if (!metadata.authorities.some((authority) => authority.startsWith("Developer ID Application:"))) {
      problems.push("release is not signed by a Developer ID Application certificate");
    }
    if (!metadata.teamIdentifier || metadata.teamIdentifier === "not set") {
      problems.push("release does not carry an Apple signing team identifier");
    }
    if (metadata.signature === "adhoc") {
      problems.push("release is only ad-hoc signed");
    }
  } else {
    problems.push(`unknown signature policy mode: ${mode}`);
  }
  return problems;
}

async function walkMacApps(directory, applications) {
  if (path.extname(directory).toLowerCase() === ".app") {
    applications.add(path.resolve(directory));
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await walkMacApps(path.join(directory, entry.name), applications);
  }
}

export async function discoverMacApps(input) {
  const resolved = path.resolve(input);
  const info = await stat(resolved);
  if (path.extname(resolved).toLowerCase() === ".app") return [resolved];
  if (!info.isDirectory()) throw new Error(`Expected an app bundle or directory, received ${resolved}`);
  const applications = new Set();
  await walkMacApps(resolved, applications);
  return [...applications].sort();
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

export function verifyMacSignature(application, mode) {
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", application], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`codesign strict verification failed for ${application}: ${error.stderr || error.message}`);
  }

  const details = run("codesign", ["-dv", "--verbose=4", application]);
  if (details.error || details.status !== 0) {
    throw new Error(`Could not inspect signature metadata for ${application}: ${details.stderr || details.error}`);
  }
  const metadata = parseCodesignMetadata(`${details.stdout}\n${details.stderr}`);
  const problems = validateSignatureMetadata(metadata, mode);

  const staple = run("xcrun", ["stapler", "validate", application]);
  if (staple.error) {
    problems.push(`could not run stapler validation: ${staple.error.message}`);
  } else if (mode === "preview" && staple.status === 0) {
    problems.push("preview unexpectedly carries a valid notarization ticket");
  } else if (mode === "release" && staple.status !== 0) {
    problems.push(`release notarization ticket is invalid: ${staple.stderr || staple.stdout}`);
  }

  if (mode === "release") {
    const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", application]);
    if (gatekeeper.error || gatekeeper.status !== 0) {
      problems.push(`Gatekeeper rejected release: ${gatekeeper.stderr || gatekeeper.error}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `macOS signature verification FAILED for ${application}:\n${problems.map((item) => `  ✗ ${item}`).join("\n")}`,
    );
  }
  return metadata;
}
