import { spawnSync } from "node:child_process";

const repoIndex = process.argv.indexOf("--repo");
const repository = repoIndex >= 0
  ? process.argv[repoIndex + 1]
  : process.env.AXIS_GITHUB_REPOSITORY || "cko-md/axis";
if (!repository) throw new Error("--repo requires an owner/repository value");
const platformIndex = process.argv.indexOf("--platform");
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : "all";
if (!["all", "apple", "windows"].includes(platform)) {
  throw new Error("--platform must be all, apple, or windows");
}

const sharedSecrets = [
  "AXIS_DESKTOP_SENTRY_DSN",
];
const appleSecrets = [
  "MAC_CSC_LINK",
  "MAC_CSC_KEY_PASSWORD",
  "APPLE_API_KEY_CONTENT",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];
const windowsSecrets = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
];
const windowsVariables = [
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERT_PROFILE",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
];

const requiredSecrets = [
  ...sharedSecrets,
  ...(platform === "all" || platform === "apple" ? appleSecrets : []),
  ...(platform === "all" || platform === "windows" ? windowsSecrets : []),
];
const requiredVariables = platform === "all" || platform === "windows" ? windowsVariables : [];

const secretResult = spawnSync("gh", ["secret", "list", "--repo", repository, "--json", "name"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (secretResult.status !== 0) process.exit(secretResult.status || 1);
const variableResult = spawnSync("gh", ["variable", "list", "--repo", repository, "--json", "name"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (variableResult.status !== 0) process.exit(variableResult.status || 1);

const configuredSecrets = new Set(JSON.parse(secretResult.stdout).map((secret) => secret.name));
const configuredVariables = new Set(JSON.parse(variableResult.stdout).map((variable) => variable.name));
const missingSecrets = requiredSecrets.filter((name) => !configuredSecrets.has(name));
const missingVariables = requiredVariables.filter((name) => !configuredVariables.has(name));

for (const name of requiredSecrets) {
  console.log(`${configuredSecrets.has(name) ? "configured" : "missing"}  secret    ${name}`);
}
for (const name of requiredVariables) {
  console.log(`${configuredVariables.has(name) ? "configured" : "missing"}  variable  ${name}`);
}

if (missingSecrets.length || missingVariables.length) {
  console.error(
    `Desktop ${platform} release credentials are incomplete for ${repository}.`,
  );
  process.exit(1);
}

console.log(`All desktop ${platform} release settings are configured for ${repository}.`);
