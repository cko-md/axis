import { describe, expect, it } from "vitest";
import { buildVectorConflictExport } from "@/components/vector/VectorConflictModal";
import type { VectorLocalConflict } from "@/lib/vector/persistence-types";

describe("VECTOR conflict export", () => {
  it("includes both recovery branches without exporting the internal owner key", () => {
    const conflict = {
      id: "22222222-2222-4222-8222-222222222222",
      ownerKey: "user:11111111-1111-4111-8111-111111111111",
      authority: "cloud",
      gameId: "second-sense",
      slotId: "main",
      reason: "revision_mismatch",
      conflictVersion: 1,
      status: "open",
      resolution: null,
      local: { state: { branch: "local" } },
      server: { state: { branch: "server" } },
      createdAt: "2026-07-16T12:00:00.000Z",
      resolvedAt: null,
    } as unknown as VectorLocalConflict;

    const exported = buildVectorConflictExport(
      conflict,
      "2026-07-16T13:00:00.000Z",
    );

    expect(exported).toMatchObject({
      schemaVersion: 1,
      exportedAt: "2026-07-16T13:00:00.000Z",
      conflict: {
        local: { state: { branch: "local" } },
        server: { state: { branch: "server" } },
      },
    });
    expect(JSON.stringify(exported)).not.toContain("11111111-1111-4111-8111-111111111111");
  });
});
