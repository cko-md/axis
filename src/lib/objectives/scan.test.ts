import { describe, expect, it, vi } from "vitest";
import { scanForObjectives } from "@/lib/objectives/scan";

// Mock the AI call so the "ai-unavailable" path is exercised deterministically.
const aiJSON = vi.fn();
vi.mock("@/lib/ai/router", () => ({
  aiJSON: (...args: unknown[]) => aiJSON(...args),
}));

/** A supabase double whose three reads all succeed with the given rows. */
function supabaseWithData(rows: {
  tasks?: unknown[];
  notes?: unknown[];
  signals?: unknown[];
  profile?: unknown;
}) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          neq: () => ({ limit: async () => ({ data: rows.tasks ?? [], error: null }) }),
          order: () => ({
            limit: async () => ({
              data: table === "notes" ? (rows.notes ?? []) : (rows.signals ?? []),
              error: null,
            }),
          }),
          maybeSingle: async () => ({ data: rows.profile ?? null, error: null }),
        }),
      }),
    }),
  } as never;
}

describe("scanForObjectives", () => {
  it("codes a platform read failure as data-load-failed", async () => {
    const supabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              limit: async () => (table === "tasks" ? { data: null, error: { message: "db down" } } : { data: [], error: null }),
            }),
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      }),
    } as never;

    const result = await scanForObjectives("user-1", supabase);
    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/could not load/i);
    // The code is what lets the background sweep tell a real DB failure apart
    // from a benign no-op — a plain string could not.
    expect(result.code).toBe("data-load-failed");
  });

  it("codes an empty platform as insufficient-activity, NOT a failure", async () => {
    // This is the case that fired a Sentry error every run: a user with nothing
    // fresh to scan is a normal no-op, not an operational failure.
    aiJSON.mockClear();
    const result = await scanForObjectives("user-1", supabaseWithData({ tasks: [], notes: [], signals: [] }));
    expect(result.results).toEqual([]);
    expect(result.code).toBe("insufficient-activity");
    // The AI must not even be consulted when there is nothing to scan.
    expect(aiJSON).not.toHaveBeenCalled();
  });

  it("codes a thrown AI call as ai-unavailable and preserves the real cause", async () => {
    const thrown = new Error("provider 529 overloaded");
    aiJSON.mockRejectedValueOnce(thrown);
    const result = await scanForObjectives(
      "user-1",
      supabaseWithData({ tasks: [{ title: "Ship 15.9", priority: "high", deadline: null, status: "todo" }] }),
    );
    expect(result.results).toEqual([]);
    expect(result.code).toBe("ai-unavailable");
    // The underlying error is carried through so the caller can report a real
    // stack instead of the contentless message that made issue 1D undebuggable.
    expect(result.cause).toBe(thrown);
  });

  it("returns suggestions with no code on success", async () => {
    aiJSON.mockResolvedValueOnce({
      results: [{ target: "Finish the arcade", module: "tasks", confidence: "high" }],
    });
    const result = await scanForObjectives(
      "user-1",
      supabaseWithData({ tasks: [{ title: "Ship 15.9", priority: "high", deadline: null, status: "todo" }] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.code).toBeUndefined();
    expect(result.results).toEqual([{ target: "Finish the arcade", module: "tasks", confidence: "high" }]);
  });
});
