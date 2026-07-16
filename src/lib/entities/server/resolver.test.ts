import { describe, expect, it } from "vitest";
import { entityUnavailable } from "./errors";
import { ENTITY_SELECTS } from "./resolver";

describe("entity server safety contracts", () => {
  it("keeps account credentials and provider item ids out of every select", () => {
    const selects = JSON.stringify(ENTITY_SELECTS);
    expect(ENTITY_SELECTS.account.split(", ")).toEqual([
      "id",
      "provider",
      "institution",
      "mask",
      "status",
      "updated_at",
    ]);
    expect(selects).not.toContain("access_token_enc");
    expect(selects).not.toContain("refresh_token_enc");
    expect(selects).not.toContain("item_id");
  });

  it("keeps opaque workflow JSON out of preview/search selects", () => {
    expect(ENTITY_SELECTS.task).not.toContain("context");
    expect(ENTITY_SELECTS.approval).not.toContain("proposed_action");
    expect(ENTITY_SELECTS.approval).not.toContain("reasons");
    expect(ENTITY_SELECTS.routine_run).not.toContain("input_snapshot");
    expect(ENTITY_SELECTS.routine_run).not.toContain("output");
    expect(ENTITY_SELECTS.routine_run).not.toContain("error");
  });

  it("serializes a provider code but never a raw database error message", () => {
    const safe = entityUnavailable("note", "search", {
      code: "PGRST500",
      message: "private query text and row content",
      details: "private details",
    });
    const serialized = JSON.stringify(safe);

    expect(safe.providerCode).toBe("PGRST500");
    expect(serialized).not.toContain("private query text");
    expect(serialized).not.toContain("private details");
  });
});
