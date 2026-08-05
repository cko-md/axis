import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolve: vi.fn(),
  rpc: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc }),
}));
vi.mock("@/lib/entities/server", () => ({ resolveEntity: mocks.resolve }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.capture }));

import { POST } from "./route";

describe("POST entity usage telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
  });

  it("normalizes unavailable ownership telemetry without provider codes", async () => {
    mocks.resolve.mockResolvedValue({
      ok: false,
      error: { code: "UNAVAILABLE", providerCode: "PRIVATE_DB_CODE", kind: "note" },
    });
    const response = await POST(
      new NextRequest("http://axis.test/api/entities/note/x", {
        method: "POST",
        body: JSON.stringify({ action: "search" }),
      }),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(503);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        area: "workspace",
        operation: "resolve",
        code: "UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("PRIVATE_DB_CODE");
  });
});
