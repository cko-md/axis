import { spawnSync } from "node:child_process";

const repoIndex = process.argv.indexOf("--repo");
const repository = repoIndex >= 0
  ? process.argv[repoIndex + 1]
  : process.env.AXIS_GITHUB_REPOSITORY || "cko-md/axis";
if (!repository) throw new Error("--repo requires an owner/repository value");
const required = [
  "AXIS_DESKTOP_SENTRY_DSN",
  "MAC_CSC_LINK",
  "MAC_CSC_KEY_PASSWORD",
  "APPLE_API_KEY_CONTENT",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

const result = spawnSync("gh", ["secret", "list", "--repo", repository, "--json", "name"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (result.status !== 0) process.exit(result.status || 1);

const configured = new Set(JSON.parse(result.stdout).map((secret) => secret.name));
const missing = required.filter((name) => !configured.has(name));

for (const name of required) {
  console.log(`${configured.has(name) ? "configured" : "missing"}  ${name}`);
}

if (missing.length) {
  console.error(
    `Desktop release credentials are incomplete for ${repository}. Run npm run desktop:secrets:configure.`,
  );
  process.exit(1);
}

console.log(`All desktop release secrets are configured for ${repository}.`);
