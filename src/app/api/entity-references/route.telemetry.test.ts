import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/entity-references", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST entity reference telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
  });

  it("normalizes unavailable endpoint telemetry without provider codes", async () => {
    mocks.resolve
      .mockResolvedValueOnce({ ok: true, entity: {} })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "UNAVAILABLE", providerCode: "PRIVATE_DB_CODE", kind: "task" },
      });
    const response = await POST(request({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "task", id: TASK_ID },
    }));
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
