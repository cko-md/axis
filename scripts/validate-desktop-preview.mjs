import electronPackage from "../electron/package.json" with { type: "json" };

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a desktop preview`);
  return value;
}

if (process.env.AXIS_DESKTOP_RELEASE === "1") {
  throw new Error("Unsigned desktop previews must not enable the signed release mode");
}

const productionUrl = new URL(requireEnv("AXIS_DESKTOP_PRODUCTION_URL"));
if (productionUrl.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(productionUrl.hostname)) {
  throw new Error("AXIS_DESKTOP_PRODUCTION_URL must be a public HTTPS origin");
}

const sentryDsn = new URL(requireEnv("AXIS_DESKTOP_SENTRY_DSN"));
if (sentryDsn.protocol !== "https:" || !sentryDsn.username || !/\/\d+\/?$/.test(sentryDsn.pathname)) {
  throw new Error("AXIS_DESKTOP_SENTRY_DSN must be a valid public Sentry DSN");
}

const expectedTag = `desktop-preview-v${electronPackage.version}`;
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== expectedTag) {
  throw new Error(`Preview tag ${process.env.GITHUB_REF_NAME} must match ${expectedTag}`);
}

for (const forbidden of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_CONTENT",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
]) {
  if (process.env[forbidden]) {
    throw new Error(`${forbidden} must not be present in the unsigned preview workflow`);
  }
}

console.log(`Unsigned desktop preview ${expectedTag} is configured for ${productionUrl.origin}.`);
