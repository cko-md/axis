/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

const isRelease = process.env.AXIS_DESKTOP_RELEASE === "1";

function packagedTarget(context) {
  const productName = context.packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case "darwin":
    case "mas":
      return path.join(context.appOutDir, `${productName}.app`);
    case "win32":
      return path.join(context.appOutDir, `${productName}.exe`);
    case "linux":
      return path.join(context.appOutDir, context.packager.executableName);
    default:
      throw new Error(`Unsupported Electron platform for fuse hardening: ${context.electronPlatformName}`);
  }
}

module.exports = async function hardenElectronFuses(context) {
  const {
    flipFuses,
    FuseVersion,
    FuseV1Options,
  } = await import("@electron/fuses");
  const { verifyFuseTarget } = await import("../scripts/desktop-fuse-policy.mjs");
  const target = packagedTarget(context);

  await flipFuses(target, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    // Non-release macOS packages have no signing pass after this hook. Reset
    // the ad-hoc signature after modifying the framework so Apple Silicon and
    // universal previews remain launchable. Release builds are signed and
    // notarized immediately after afterPack, so they must not be ad-hoc signed.
    resetAdHocDarwinSignature:
      !isRelease && (context.electronPlatformName === "darwin" || context.electronPlatformName === "mas"),
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  });

  await verifyFuseTarget(target);
};

module.exports.packagedTarget = packagedTarget;
