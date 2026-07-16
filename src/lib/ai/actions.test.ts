import { describe, expect, it } from "vitest";
import {
  AI_ACTION_DEFS,
  buildAiRequestBody,
  isSensitiveAiAction,
  type AiActionName,
} from "@/lib/ai/actions";

describe("AI action registry", () => {
  it("maps every action to a non-empty server mode", () => {
    for (const [name, def] of Object.entries(AI_ACTION_DEFS)) {
      expect(def.mode, `${name} has an empty mode`).toMatch(/\S/);
    }
  });

  it("has unique server modes", () => {
    const modes = Object.values(AI_ACTION_DEFS).map((d) => d.mode);
    expect(new Set(modes).size).toBe(modes.length);
  });

  it("enforces the client-side navigation allowlist for deck cards", () => {
    const meta = { source: "model", degraded: false, reason: null } as const;
    expect(AI_ACTION_DEFS.deckInsights.output.safeParse({
      cards: [{
        id: "0",
        title: "Open agenda",
        body: "Review today's priorities.",
        actionLabel: "Review",
        actionPath: "/agenda",
      }],
      meta,
    }).success).toBe(true);

    for (const actionPath of [
      "javascript:alert(1)",
      "//evil.example",
      "/%2f%2fevil.example",
      "/agenda/child",
      "/unknown",
    ]) {
      expect(AI_ACTION_DEFS.deckInsights.output.safeParse({
        cards: [{
          id: "0",
          title: "Unsafe",
          body: "Must not navigate.",
          actionLabel: "Open",
          actionPath,
        }],
        meta,
      }).success, actionPath).toBe(false);
    }
  });
});

describe("buildAiRequestBody", () => {
  it("produces the canonical { mode, ...input } body the route expects", () => {
    // This is the exact contract the old Mail call violated (it sent
    // `{ action: "triage" }` with no `mode`/`text`).
    expect(buildAiRequestBody("triage", { text: "IRB", body: "Sign the IRB amendment" })).toEqual({
      mode: "triage",
      text: "IRB",
      body: "Sign the IRB amendment",
    });
    expect(buildAiRequestBody("noteRewrite", { text: "make this clearer" })).toEqual({
      mode: "notes-rewrite",
      text: "make this clearer",
    });
    expect(buildAiRequestBody("meetingSummary", { text: "transcript", title: "Lab sync" })).toEqual({
      mode: "meeting-summary",
      text: "transcript",
      title: "Lab sync",
    });
    expect(buildAiRequestBody("regimenPlan", { text: "half marathon", body: "{\"daysPerWeek\":4}" })).toEqual({
      mode: "regimenPlan",
      text: "half marathon",
      body: "{\"daysPerWeek\":4}",
    });
    expect(buildAiRequestBody("flashcards", { text: "source text", title: "DBS notes" })).toEqual({
      mode: "flashcards",
      text: "source text",
      title: "DBS notes",
    });
    expect(buildAiRequestBody("studySummary", { text: "source text", title: "DBS notes" })).toEqual({
      mode: "summary",
      text: "source text",
      title: "DBS notes",
    });
  });

  it("throws (does not send) on invalid input", () => {
    // empty text is rejected before any network call
    expect(() => buildAiRequestBody("triage", { text: "" })).toThrow(/Invalid input for AI action "triage"/);
  });

  it("strips unknown keys so drift can't leak into the payload", () => {
    const body = buildAiRequestBody("debriefSummary", { text: "wins and challenges", extra: "x" } as never);
    expect(body).toEqual({ mode: "debrief_summary", text: "wins and challenges" });
  });
});

describe("isSensitiveAiAction", () => {
  it("flags content-bearing actions as privacy-sensitive (AI-4 groundwork)", () => {
    const names: AiActionName[] = ["triage", "route", "noteSummarize", "noteRewrite", "noteTitle", "debriefSummary"];
    for (const n of names) expect(isSensitiveAiAction(n)).toBe(true);
  });
});
