import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "electron/build/icon.icns",
  "electron/build/icon.ico",
  "electron/build/icon.png",
  "electron/build/icons/512x512.png",
  "electron/desktop-observability.cjs",
  "electron/electron-builder.cjs",
  "electron/update-controller.cjs",
];

await Promise.all(requiredFiles.map((file) => access(path.join(root, file))));

const packageJson = JSON.parse(await readFile(path.join(root, "electron/package.json"), "utf8"));
const mainSource = await readFile(path.join(root, "electron/main.cjs"), "utf8");
const builderSource = await readFile(path.join(root, "electron/electron-builder.cjs"), "utf8");
async function sourceFilesIn(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") return [];
      return sourceFilesIn(relative);
    }
    return /\.(?:[cm]?js|jsx|ts|tsx)$/.test(entry.name) ? [relative] : [];
  }));
  return nested.flat();
}

const sourceFiles = [
  ...(await sourceFilesIn("src")),
  ...(await sourceFilesIn("electron")),
];

if (!packageJson.axisDesktop?.productionUrl?.startsWith("https://")) {
  throw new Error("Packaged AXIS desktop origin must be an explicit HTTPS URL");
}
if (packageJson.dependencies?.["electron-updater"] !== "6.8.9") {
  throw new Error("electron-updater must remain an exact runtime dependency");
}
for (const invariant of [
  "contextIsolation: true",
  "nodeIntegration: false",
  "sandbox: true",
  "webSecurity: true",
  'partition: "persist:axis-browser"',
]) {
  if (!mainSource.includes(invariant)) throw new Error(`Missing Electron security invariant: ${invariant}`);
}
for (const invariant of ["forceCodeSigning", "hardenedRuntime: isRelease", "notarize: isRelease"]) {
  if (!builderSource.includes(invariant)) throw new Error(`Missing release invariant: ${invariant}`);
}

for (const file of sourceFiles) {
  const source = await readFile(path.join(root, file), "utf8");
  const sandboxAttributes = source.match(/sandbox\s*=\s*["'`][^"'`]+["'`]/gs) || [];
  if (sandboxAttributes.some((value) => value.includes("allow-scripts") && value.includes("allow-same-origin"))) {
    throw new Error(`Unsafe iframe sandbox combination found in ${file}`);
  }
}

try {
  await access(path.join(root, "src/components/layout/ExternalWindow.tsx"));
  throw new Error("Legacy ExternalWindow iframe must not be restored");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

console.log("Desktop origin, release, icon, updater, and sandbox security invariants are present.");
