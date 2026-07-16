import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_ACTION_DEFS, isSensitiveAiAction, type AiActionName } from "@/lib/ai/actions";

// AI-4: privacy guarantee. AI actions send user content (mail/note bodies,
// reflections, health, finance) to the model provider — that content must
// never be written to a log sink (console / Sentry), where it would leak into
// error dashboards. This guard scans the AI route source and fails if any
// logging call references a request-payload identifier. Precise identifiers
// (the actual payload vars) rather than broad matches, to avoid false alarms
// on safe fields like `mode` or `err.message`.

const REPO = join(__dirname, "..", "..", "..");
const AI_ROUTE_FILES = [
  "src/app/api/ai/route.ts",
  "src/app/api/signals-ai/route.ts",
];
const SAFE_AI_OBSERVABILITY_FILES = [
  "src/app/api/ai/route.ts",
  "src/lib/ai/router.ts",
];
const CONSOLE_MODULE = "src/components/console/ConsoleModule.tsx";

// Identifiers that carry user content in these routes.
const PAYLOAD_IDENTIFIERS = /\b(text|body|prompt|userMessage|combined)\b/;
const LOG_CALL = /(console\.(log|error|warn|info|debug)|Sentry\.(captureException|captureMessage)|logger\.)/;

describe("AI route logging privacy (AI-4)", () => {
  for (const rel of AI_ROUTE_FILES) {
    it(`${rel} never logs a request payload`, () => {
      const source = readFileSync(join(REPO, rel), "utf8");
      const offenders = source
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => LOG_CALL.test(line) && PAYLOAD_IDENTIFIERS.test(line));
      expect(
        offenders,
        `${rel} logs a user-content payload — log safe metadata (mode/status/code) only`,
      ).toEqual([]);
    });
  }

  it("uses structured safe observability instead of raw console errors", () => {
    for (const rel of SAFE_AI_OBSERVABILITY_FILES) {
      const source = readFileSync(join(REPO, rel), "utf8");
      expect(source, `${rel} must not write raw provider errors to console`)
        .not.toMatch(/console\.(log|error|warn|info|debug)\s*\(/);
      expect(source, `${rel} must use the safe route-error metadata boundary`)
        .toContain("captureRouteError(");
      expect(source, `${rel} must not send the raw provider exception to Sentry`)
        .not.toMatch(/captureRouteError\(\s*err\b/);
    }
  });
});

describe("sensitive AI actions are flagged", () => {
  it("every content-bearing action declares sensitive:true", () => {
    // All currently-registered actions send user content, so all must be
    // sensitive. If a genuinely non-sensitive action is added later, relax this.
    for (const name of Object.keys(AI_ACTION_DEFS) as AiActionName[]) {
      expect(isSensitiveAiAction(name), `${name} must declare sensitive:true`).toBe(true);
    }
  });
});

describe("Console AI call-site privacy", () => {
  it("routes dispatch triage through the typed AI action registry", () => {
    const source = readFileSync(join(REPO, CONSOLE_MODULE), "utf8");

    expect(source).toContain('callAiAction("triage"');
    expect(source).not.toContain('JSON.stringify({ mode: "triage"');
  });
});
