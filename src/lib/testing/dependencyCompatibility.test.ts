import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const root = process.cwd();

type Lockfile = {
  packages?: Record<string, { version?: string }>;
};

type SharpPipeline = {
  png: () => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
  metadata: () => Promise<{ format?: string; width?: number; height?: number }>;
};

type SharpFactory = (input: Buffer | {
  create: {
    width: number;
    height: number;
    channels: 4;
    background: { r: number; g: number; b: number; alpha: number };
  };
}) => SharpPipeline;

describe("security override compatibility", () => {
  it("keeps brace expansion callable for every installed minimatch major", () => {
    const lock = JSON.parse(
      readFileSync(path.join(root, "package-lock.json"), "utf8"),
    ) as Lockfile;
    const minimatchPackages = Object.entries(lock.packages ?? {})
      .filter(([packagePath]) => /(?:^|\/)node_modules\/minimatch$/.test(packagePath));

    expect(minimatchPackages.length).toBeGreaterThan(0);
    for (const [packagePath, metadata] of minimatchPackages) {
      if (!existsSync(path.join(root, packagePath))) {
        continue;
      }

      const loaded = requireFromTest(path.join(root, packagePath)) as
        | ((candidate: string, pattern: string) => boolean)
        | { minimatch?: (candidate: string, pattern: string) => boolean };
      const match = typeof loaded === "function" ? loaded : loaded.minimatch;

      expect(match, `minimatch ${metadata.version ?? "unknown"} exports a matcher`)
        .toBeTypeOf("function");
      expect(
        match?.("a.js", "{a,b}.js"),
        `minimatch ${metadata.version ?? "unknown"} retains brace semantics`,
      ).toBe(true);
    }
  });

  it("keeps Next's patched sharp override operational for image transforms", async () => {
    // Next carries sharp as an optional runtime dependency, so it is not part
    // of this application's TypeScript surface. Exercise the installed CJS
    // implementation directly instead of inventing a duplicate declaration.
    const sharp = requireFromTest("sharp") as SharpFactory;
    const image = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 8, g: 16, b: 32, alpha: 1 },
      },
    }).png().toBuffer();
    const metadata = await sharp(image).metadata();

    expect(metadata).toMatchObject({ format: "png", width: 1, height: 1 });
  });
});
