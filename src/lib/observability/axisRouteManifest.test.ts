import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { AXIS_ROUTE_MANIFEST } from "./axisRouteManifest";

function filesystemRoutes() {
  const root = resolve(process.cwd(), "src/app");
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (entry.name === "page.tsx" || entry.name === "route.ts")) files.push(path);
    }
  };
  walk(root);
  return files.map((file) => file.slice(root.length).replace(/\/(?:page\.tsx|route\.ts)$/, "") || "/").filter((route) => route !== "/monitoring").sort();
}

describe("AXIS telemetry route manifest", () => {
  it("is an exact reviewed projection of app routes", () => {
    expect(existsSync(resolve(process.cwd(), "src/app"))).toBe(true);
    expect([...AXIS_ROUTE_MANIFEST].sort()).toEqual(filesystemRoutes());
    expect(new Set(AXIS_ROUTE_MANIFEST).size).toBe(AXIS_ROUTE_MANIFEST.length);
  });
});
