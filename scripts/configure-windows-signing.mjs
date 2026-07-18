import { spawnSync } from "node:child_process";
import path from "node:path";

function usage() {
  console.error(
    "Usage: npm run desktop:windows-signing:configure -- " +
    "--tenant-id <guid> --client-id <guid> --endpoint https://<region>.codesigning.azure.net/ " +
    "--account <trusted-signing-account> --profile <certificate-profile> --publisher <certificate-CN>",
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
  if (process.env.AZURE_CLIENT_SECRET) return process.env.AZURE_CLIENT_SECRET;
  if (!process.stdin.isTTY) {
    throw new Error("AZURE_CLIENT_SECRET is required when stdin is not an interactive terminal");
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
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function setSecret(repository, name, value) {
  run("gh", ["secret", "set", name, "--repo", repository], {
    input: value,
    encoding: "utf8",
  });
}

function setVariable(repository, name, value) {
  run("gh", ["variable", "set", name, "--repo", repository, "--body", value]);
}

const args = parseArgs(process.argv.slice(2));
const repository = args.repo || process.env.AXIS_GITHUB_REPOSITORY || "cko-md/axis";
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tenantId = String(args["tenant-id"] || "").trim();
const clientId = String(args["client-id"] || "").trim();
const account = String(args.account || "").trim();
const profile = String(args.profile || "").trim();
const publisher = String(args.publisher || "").trim();
let endpoint;

try {
  endpoint = new URL(String(args.endpoint || "").trim());
} catch {
  endpoint = null;
}

if (!guid.test(tenantId) || !guid.test(clientId) || endpoint?.protocol !== "https:" ||
    !account || !profile || !publisher) {
  usage();
  process.exit(2);
}

run("gh", ["auth", "status"]);
const clientSecret = await promptHidden("Azure service-principal client secret: ");
if (!clientSecret) throw new Error("The Azure client secret must not be empty");

setSecret(repository, "AZURE_TENANT_ID", tenantId);
setSecret(repository, "AZURE_CLIENT_ID", clientId);
setSecret(repository, "AZURE_CLIENT_SECRET", clientSecret);
setVariable(repository, "AZURE_TRUSTED_SIGNING_ENDPOINT", endpoint.href);
setVariable(repository, "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME", account);
setVariable(repository, "AZURE_TRUSTED_SIGNING_CERT_PROFILE", profile);
setVariable(repository, "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME", publisher);

console.log(`Azure Artifact Signing settings were stored in ${repository} without printing secret values.`);
run(process.execPath, [
  path.join(import.meta.dirname, "check-desktop-release-secrets.mjs"),
  "--repo",
  repository,
  "--platform",
  "windows",
], {
  encoding: "utf8",
});
