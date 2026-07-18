import electronPackage from "../electron/package.json" with { type: "json" };

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a desktop release`);
  return value;
}

if (process.env.AXIS_DESKTOP_RELEASE !== "1") {
  throw new Error("AXIS_DESKTOP_RELEASE=1 is required for release packaging");
}

const productionUrl = new URL(requireEnv("AXIS_DESKTOP_PRODUCTION_URL"));
if (productionUrl.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(productionUrl.hostname)) {
  throw new Error("AXIS_DESKTOP_PRODUCTION_URL must be a public HTTPS origin");
}

const sentryDsn = new URL(requireEnv("AXIS_DESKTOP_SENTRY_DSN"));
if (sentryDsn.protocol !== "https:" || !sentryDsn.username || !/\/\d+\/?$/.test(sentryDsn.pathname)) {
  throw new Error("AXIS_DESKTOP_SENTRY_DSN must be a valid public Sentry DSN");
}

const expectedTag = `desktop-v${electronPackage.version}`;
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== expectedTag) {
  throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} must match ${expectedTag}`);
}

if (process.platform === "darwin") {
  for (const name of [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]) {
    requireEnv(name);
  }
}

if (process.platform === "win32") {
  for (const name of [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERT_PROFILE",
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  ]) {
    requireEnv(name);
  }
}

console.log(`Desktop release ${expectedTag} is configured for ${productionUrl.origin}.`);
