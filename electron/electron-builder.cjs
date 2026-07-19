const isRelease = process.env.AXIS_DESKTOP_RELEASE === "1";
const isWindowsRelease = isRelease && process.platform === "win32";
const productionUrl = process.env.AXIS_DESKTOP_PRODUCTION_URL || "https://axis-cko.vercel.app";
const sentryDsn = process.env.AXIS_DESKTOP_SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";

function requireReleaseEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production desktop signing`);
  return value;
}

function requireProductionUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("AXIS_DESKTOP_PRODUCTION_URL must be a public HTTPS origin");
  }
  return url.origin;
}

const verifiedProductionUrl = requireProductionUrl(productionUrl);
if (isRelease && !sentryDsn) {
  throw new Error("AXIS_DESKTOP_SENTRY_DSN is required for release crash reporting");
}
const windowsAzureSignOptions = isWindowsRelease ? {
  publisherName: requireReleaseEnv("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: requireReleaseEnv("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: requireReleaseEnv("AZURE_TRUSTED_SIGNING_CERT_PROFILE"),
  codeSigningAccountName: requireReleaseEnv("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: "SHA256",
  timestampDigest: "SHA256",
  timestampRfc3161: "http://timestamp.acs.microsoft.com",
} : undefined;

module.exports = {
  appId: "com.axis.desktop",
  productName: "AXIS",
  electronVersion: "43.1.1",
  electronLanguages: ["en-US"],
  asar: true,
  compression: "maximum",
  removePackageKeywords: true,
  removePackageScripts: true,
  forceCodeSigning: isRelease && (process.platform === "darwin" || process.platform === "win32"),
  // Package-time Electron fuses. These are flipped in the packaged binary
  // itself, so they hold even if someone tampers with the JavaScript: an
  // attacker who can drop a file next to the app still cannot turn it into a
  // general-purpose Node runtime.
  //
  // runAsNode / NODE_OPTIONS / inspect arguments are the three standard ways to
  // coerce an Electron binary into executing arbitrary code with the app's
  // entitlements — all disabled. ASAR integrity plus only-load-from-ASAR means
  // a swapped or added source file fails to load rather than silently
  // executing. Cookie encryption protects the session cookies at rest, which
  // for AXIS includes the Supabase session and the OAuth tokens.
  //
  // Verified after packaging by scripts/verify-desktop-fuses.mjs — a fuse
  // asserted in config but not present in the artifact is worth nothing.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  directories: {
    buildResources: "build",
    output: "../dist-electron",
  },
  files: [
    "*.cjs",
    "!*.test.cjs",
    "*.html",
    "*.css",
    "*.js",
    "package.json",
    "node_modules/**/*",
    "build/icon.png",
    // Phase 16.2 managed melonDS runtime manifest + GPL-3.0 license text
    // (config/archive-bay-runtimes.json, config/melonDS-LICENSE.txt). These
    // are reference data read at runtime, not the melonDS binary itself —
    // the actual downloaded runtime always lives in userData, outside the
    // asar (see electron/archive-bay-runtime.cjs).
    "config/**/*",
  ],
  extraMetadata: {
    axisDesktop: {
      productionUrl: verifiedProductionUrl,
      sentryDsn,
    },
  },
  artifactName: "AXIS-${version}-${os}-${arch}.${ext}",
  publish: [{
    provider: "github",
    owner: "cko-md",
    repo: "axis",
    releaseType: "release",
    tagNamePrefix: "desktop-v",
  }],
  mac: {
    category: "public.app-category.productivity",
    hardenedRuntime: isRelease,
    icon: "build/icon.icns",
    notarize: isRelease,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: isRelease,
  },
  win: {
    ...(windowsAzureSignOptions ? { azureSignOptions: windowsAzureSignOptions } : {}),
    forceCodeSigning: isRelease,
    icon: "build/icon.ico",
    target: "nsis",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    category: "Office",
    icon: "build/icons",
    target: ["AppImage"],
  },
};
