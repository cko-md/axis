import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("dist-electron");
const enforceBudgets = process.argv.includes("--check");
const budgets = {
  app: 250 * 1024 * 1024,
  asar: 5 * 1024 * 1024,
  artifact: 120 * 1024 * 1024,
};

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? files(target) : [target];
  }));
  return nested.flat();
}

try {
  let failed = false;
  const artifacts = (await files(root)).filter((file) => /\.(dmg|zip|exe|AppImage)$/i.test(file));
  const applications = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^mac/.test(entry.name))
    .map((entry) => path.join(root, entry.name, "AXIS.app"));

  for (const application of applications) {
    try {
      const applicationFiles = await files(application);
      const size = (await Promise.all(applicationFiles.map((file) => stat(file))))
        .reduce((total, file) => total + file.size, 0);
      console.log(`${path.relative(root, application)}: ${(size / 1024 / 1024).toFixed(1)} MiB unpacked`);
      if (enforceBudgets && size > budgets.app) failed = true;

      const asar = path.join(application, "Contents", "Resources", "app.asar");
      const asarSize = (await stat(asar)).size;
      console.log(`${path.relative(root, asar)}: ${(asarSize / 1024 / 1024).toFixed(1)} MiB application code`);
      if (enforceBudgets && asarSize > budgets.asar) failed = true;
    } catch {
      // A partially built architecture directory is not a reportable app.
    }
  }

  for (const artifact of artifacts) {
    const size = (await stat(artifact)).size;
    console.log(`${path.relative(root, artifact)}: ${(size / 1024 / 1024).toFixed(1)} MiB`);
    if (enforceBudgets && size > budgets.artifact) failed = true;
  }

  if (enforceBudgets && failed) {
    console.error("Desktop size budget exceeded (250 MiB app, 5 MiB ASAR, or 120 MiB artifact).");
    process.exit(1);
  }
  if (artifacts.length === 0 && applications.length === 0) {
    console.log("No packaged desktop artifacts found in dist-electron.");
  }
} catch {
  console.log("No dist-electron directory found. Run npm run desktop:dist first.");
}
