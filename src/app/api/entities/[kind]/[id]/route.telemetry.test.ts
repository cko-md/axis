import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolve: vi.fn(),
  from: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/entities/server", () => ({ resolveEntity: mocks.resolve }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.capture }));

import { GET } from "./route";

function referenceQuery(data: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) query[method] = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
  return query;
}

describe("GET entity preview telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
  });

  it("normalizes stored-edge resolution telemetry without provider codes", async () => {
    mocks.resolve
      .mockResolvedValueOnce({
        ok: true,
        entity: { ref: { kind: "note", id: NOTE_ID }, title: "Alpha", href: "/notes", meta: [] },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "UNAVAILABLE", providerCode: "DB_UNAVAILABLE", kind: "task" },
      });
    mocks.from
      .mockImplementationOnce(() => referenceQuery([{
        id: "ref_1",
        source_kind: "note",
        source_id: NOTE_ID,
        target_kind: "task",
        target_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        relation: "related",
        label: null,
        origin: "user",
        created_at: "2026-07-16T00:00:00.000Z",
      }]))
      .mockImplementationOnce(() => referenceQuery([]));

    const response = await GET(
      new NextRequest("http://axis.test/api/entities/note/x"),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ referencesStatus: "unavailable" });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        area: "workspace",
        operation: "reference_resolution",
        code: "UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("DB_UNAVAILABLE");
  });
});
