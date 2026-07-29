#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const [mode, ...builderArgs] = process.argv.slice(2);
if (!["dist", "dir", "release"].includes(mode)) {
  console.error("Usage: node scripts/build-desktop.mjs <dist|dir|release> [...electron-builder args]");
  process.exit(2);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve();
    });
  });
}

const root = process.cwd();
const builder = path.join(root, "node_modules", "electron-builder", "cli.js");
const baseBuilderArgs = [
  builder,
  "--projectDir",
  "electron",
  "--config",
  "electron-builder.cjs",
];
if (mode === "dir") baseBuilderArgs.push("--dir");
baseBuilderArgs.push(...builderArgs);

try {
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "desktop:check"]);
  if (mode === "release") {
    await run(process.execPath, [path.join(root, "scripts", "validate-desktop-release.mjs")]);
  }
  await run(process.execPath, baseBuilderArgs);
  await run(process.execPath, [
    path.join(root, "scripts", "verify-desktop-fuses.mjs"),
    path.join(root, "dist-electron"),
  ]);

  const hasExplicitPlatform = builderArgs.some((argument) =>
    ["--mac", "--win", "--linux"].includes(argument),
  );
  const buildsMac =
    builderArgs.includes("--mac") || (!hasExplicitPlatform && process.platform === "darwin");
  if (buildsMac) {
    await run(process.execPath, [
      path.join(root, "scripts", "verify-desktop-signature.mjs"),
      mode === "release" ? "--release" : "--preview",
      path.join(root, "dist-electron"),
    ]);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
