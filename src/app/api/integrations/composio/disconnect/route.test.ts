import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE } from "./route";

const deleteConnectedAccount = vi.fn();
const from = vi.fn();
const getUser = vi.fn();

vi.mock("@/lib/integrations/composio", () => ({
  deleteConnectedAccount: (...args: unknown[]) => deleteConnectedAccount(...args),
  isSupportedToolkit: (toolkit: string) => ["gmail", "outlook", "googlecalendar", "googlecontacts", "strava", "spotify"].includes(toolkit),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from,
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

type ConnectionRow = { id: string; connected_account_id: string };

function request(toolkit = "gmail") {
  return new NextRequest(`http://axis.test/api/integrations/composio/disconnect?toolkit=${toolkit}`, { method: "DELETE" });
}

function mockSupabase(rows: ConnectionRow[], opts: { cleanupError?: Error } = {}) {
  const deleteIn = vi.fn(async () => ({ error: opts.cleanupError ?? null }));
  const deleteEq = vi.fn(() => ({ in: deleteIn }));
  const selectEqToolkit = vi.fn(async () => ({ data: rows, error: null }));
  const selectEqUser = vi.fn(() => ({ eq: selectEqToolkit }));
  const select = vi.fn(() => ({ eq: selectEqUser }));
  const deleteQuery = vi.fn(() => ({ eq: deleteEq }));

  from.mockReturnValue({ select, delete: deleteQuery });
  return { deleteIn };
}

describe("DELETE /api/integrations/composio/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "user_1" } } });
  });

  it("does not delete the local connection when Composio revocation fails", async () => {
    const { deleteIn } = mockSupabase([{ id: "row_1", connected_account_id: "ca_1" }]);
    deleteConnectedAccount.mockRejectedValueOnce(new Error("provider down"));

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ failed: 1, disconnected: 0 });
    expect(deleteIn).not.toHaveBeenCalled();
  });

  it("cleans up only successfully revoked local rows", async () => {
    const rows = [
      { id: "row_1", connected_account_id: "ca_1" },
      { id: "row_2", connected_account_id: "ca_2" },
    ];
    const { deleteIn } = mockSupabase(rows);
    deleteConnectedAccount
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("provider down"));

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ failed: 1, disconnected: 1 });
    expect(deleteIn).toHaveBeenCalledWith("id", ["row_1"]);
  });

  it("returns success after all remote revocations and local cleanup succeed", async () => {
    const { deleteIn } = mockSupabase([{ id: "row_1", connected_account_id: "ca_1" }]);
    deleteConnectedAccount.mockResolvedValueOnce(undefined);

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, disconnected: 1 });
    expect(deleteIn).toHaveBeenCalledWith("id", ["row_1"]);
  });
});
