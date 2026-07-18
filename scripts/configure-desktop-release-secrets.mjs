import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  console.error(
    "Usage: npm run desktop:secrets:configure -- --certificate /path/DeveloperID.p12 " +
    "--api-key /path/AuthKey.p8 --key-id ABC123DEFG --issuer 00000000-0000-0000-0000-000000000000",
  );
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value) {
      usage();
      process.exit(2);
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

async function promptHidden(prompt) {
  if (process.env.MAC_CSC_KEY_PASSWORD) return process.env.MAC_CSC_KEY_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new Error("MAC_CSC_KEY_PASSWORD is required when stdin is not an interactive terminal");
  }

  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding,
    input: options.input,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function setSecret(repository, name, value) {
  run("gh", ["secret", "set", name, "--repo", repository], {
    input: value,
    encoding: typeof value === "string" ? "utf8" : undefined,
  });
}

const args = parseArgs(process.argv.slice(2));
const repository = args.repo || process.env.AXIS_GITHUB_REPOSITORY || "cko-md/axis";
const certificatePath = path.resolve(args.certificate || "");
const apiKeyPath = path.resolve(args["api-key"] || "");
const keyId = String(args["key-id"] || "").trim();
const issuer = String(args.issuer || "").trim();

if (!args.certificate || !args["api-key"] || !/^[A-Z0-9]{10}$/.test(keyId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuer)) {
  usage();
  process.exit(2);
}

run("gh", ["auth", "status"]);
const certificate = await readFile(certificatePath);
const apiKey = await readFile(apiKeyPath, "utf8");
if (!apiKey.includes("BEGIN PRIVATE KEY")) {
  throw new Error("The App Store Connect API key is not a valid .p8 private key");
}

const password = await promptHidden("Developer ID certificate password: ");
if (!password) throw new Error("The certificate password must not be empty");

const validation = spawnSync(
  "openssl",
  ["pkcs12", "-in", certificatePath, "-noout", "-passin", "stdin"],
  { input: `${password}\n`, encoding: "utf8", stdio: ["pipe", "ignore", "inherit"] },
);
if (validation.status !== 0) {
  throw new Error("The Developer ID certificate or its password is invalid");
}

setSecret(repository, "MAC_CSC_LINK", certificate.toString("base64"));
setSecret(repository, "MAC_CSC_KEY_PASSWORD", password);
setSecret(repository, "APPLE_API_KEY_CONTENT", apiKey);
setSecret(repository, "APPLE_API_KEY_ID", keyId);
setSecret(repository, "APPLE_API_ISSUER", issuer);

console.log(`Apple desktop release credentials were stored in ${repository} without printing their values.`);
run(process.execPath, [
  path.join(import.meta.dirname, "check-desktop-release-secrets.mjs"),
  "--repo",
  repository,
  "--platform",
  "apple",
], {
  encoding: "utf8",
});
