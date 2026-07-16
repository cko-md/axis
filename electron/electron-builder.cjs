const isRelease = process.env.AXIS_DESKTOP_RELEASE === "1";
const productionUrl = process.env.AXIS_DESKTOP_PRODUCTION_URL || "https://axis-cko.vercel.app";
const sentryDsn = process.env.AXIS_DESKTOP_SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";

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

module.exports = {
  appId: "com.axis.desktop",
  productName: "AXIS",
  electronVersion: "43.1.1",
  electronLanguages: ["en-US"],
  asar: true,
  compression: "maximum",
  removePackageKeywords: true,
  removePackageScripts: true,
  forceCodeSigning: isRelease && process.platform === "darwin",
  directories: {
    buildResources: "build",
    output: "../dist-electron",
  },
  files: [
    "*.cjs",
    "*.html",
    "*.css",
    "*.js",
    "package.json",
    "node_modules/**/*",
    "build/icon.png",
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
