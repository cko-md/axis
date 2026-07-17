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

function emptyReferenceQuery() {
  return referenceQuery([]);
}

function referenceQuery(data: unknown[]) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) query[method] = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
  return query;
}

describe("GET /api/entities/[kind]/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.from.mockImplementation(() => emptyReferenceQuery());
  });

  it("returns the same not-found response for an unresolved owner-scoped entity", async () => {
    mocks.resolve.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", kind: "note" } });
    const response = await GET(
      new NextRequest("http://axis.test/api/entities/note/x"),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns a preview without mutating frecency on hover", async () => {
    mocks.resolve.mockResolvedValue({
      ok: true,
      entity: { ref: { kind: "note", id: NOTE_ID }, title: "Alpha", href: "/notes", meta: [] },
    });
    const response = await GET(
      new NextRequest("http://axis.test/api/entities/note/x"),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ entity: { title: "Alpha" }, outgoing: [], backlinks: [], referencesStatus: "ok" });
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it("marks references unavailable when a stored edge cannot be resolved", async () => {
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
      .mockImplementationOnce(() => emptyReferenceQuery());

    const response = await GET(
      new NextRequest("http://axis.test/api/entities/note/x"),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outgoing: [],
      backlinks: [],
      referencesStatus: "unavailable",
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "reference_resolution" }),
    );
  });
});
