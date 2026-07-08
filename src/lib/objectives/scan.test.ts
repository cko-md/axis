import { describe, expect, it } from "vitest";
import { scanForObjectives } from "@/lib/objectives/scan";

describe("scanForObjectives", () => {
  it("returns a visible error when platform reads fail", async () => {
    const supabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              limit: async () => (table === "tasks" ? { data: null, error: { message: "db down" } } : { data: [], error: null }),
            }),
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }),
    } as never;

    const result = await scanForObjectives("user-1", supabase);
    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/could not load/i);
  });
});
