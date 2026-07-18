import electronPackage from "electron/package.json" with { type: "json" };

const minimumMajor = 43;
const installedMajor = Number.parseInt(electronPackage.version.split(".")[0], 10);

if (!Number.isFinite(installedMajor) || installedMajor < minimumMajor) {
  console.error(`Electron ${electronPackage.version} is below the maintained AXIS baseline (${minimumMajor}.x).`);
  process.exit(1);
}

console.log(`Electron ${electronPackage.version} meets the AXIS maintained baseline (${minimumMajor}.x).`);
