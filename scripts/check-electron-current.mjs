import electronPackage from "electron/package.json" with { type: "json" };

const response = await fetch("https://registry.npmjs.org/electron/latest", {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});

if (!response.ok) {
  throw new Error(`Could not query the Electron release channel (${response.status})`);
}

const latest = await response.json();
if (typeof latest.version !== "string") {
  throw new Error("Electron release channel returned an invalid version");
}

if (electronPackage.version !== latest.version) {
  console.error(
    `Electron ${electronPackage.version} is pinned, but the current stable release is ${latest.version}.`,
  );
  process.exit(1);
}

console.log(`Electron ${electronPackage.version} matches the current stable release.`);
