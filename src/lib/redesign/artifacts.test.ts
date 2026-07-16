import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Guard test (§12): the machine-readable program-state artifacts under
 * .claude/axis-redesign/ must always be valid JSON. These are hand-edited each
 * wave, and a stray comma silently corrupts the source of truth a resuming
 * session relies on — so CI parses them on every run.
 */
const DIR = path.resolve(process.cwd(), ".claude/axis-redesign");

describe("redesign JSON artifacts are valid", () => {
  it("PROGRAM_STATE.json parses and has the expected shape", () => {
    const raw = readFileSync(path.join(DIR, "PROGRAM_STATE.json"), "utf8");
    const parsed = JSON.parse(raw) as { program?: string; waves?: unknown[] };
    expect(parsed.program).toBe("axis-system-redesign");
    expect(Array.isArray(parsed.waves)).toBe(true);
  });

  it("keeps the lifecycle authority migration atomic around its data preflight", () => {
    const migration = readFileSync(
      path.resolve(
        process.cwd(),
        "supabase/migrations/202607161000_lifecycle_claims.sql",
      ),
      "utf8",
    );
    const beginAt = migration.indexOf("\nbegin;");
    const preflightAt = migration.indexOf(
      "duplicate routine approval links must be resolved before lifecycle claims",
    );
    const commitAt = migration.lastIndexOf("\ncommit;");

    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(preflightAt).toBeGreaterThan(beginAt);
    expect(commitAt).toBeGreaterThan(preflightAt);
    expect(migration.slice(commitAt).trim()).toBe("commit;");
  });

  it("every .json artifact in .claude/axis-redesign parses", () => {
    if (!existsSync(DIR)) return; // artifacts optional in a stripped checkout
    const jsonFiles = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const file of jsonFiles) {
      const raw = readFileSync(path.join(DIR, file), "utf8");
      expect(() => JSON.parse(raw), `${file} is not valid JSON`).not.toThrow();
    }
  });
});
