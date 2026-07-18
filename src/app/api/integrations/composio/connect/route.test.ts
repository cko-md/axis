import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const getOrCreateAuthConfig = vi.fn();
const initiateConnection = vi.fn();
const deleteConnectedAccount = vi.fn();
const getUser = vi.fn();
const from = vi.fn();

vi.mock("@/lib/integrations/composio", () => ({
  getOrCreateAuthConfig: (...args: unknown[]) => getOrCreateAuthConfig(...args),
  initiateConnection: (...args: unknown[]) => initiateConnection(...args),
  isSupportedToolkit: (toolkit: string) =>
    ["gmail", "outlook", "googlecalendar", "googlecontacts", "strava", "spotify"].includes(toolkit),
  CUSTOM_AUTH_TOOLKITS: ["googlecontacts", "spotify"],
  ComposioError: class ComposioError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  deleteConnectedAccount: (...args: unknown[]) => deleteConnectedAccount(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, from }),
}));

vi.mock("@/lib/auth/getAppOrigin", () => ({
  getAppOrigin: () => "http://axis.test",
  buildAppUrl: (_req: NextRequest, path: string) => `http://axis.test${path}`,
}));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException, addBreadcrumb: vi.fn() }));

function request(toolkit: string) {
  return new NextRequest(`http://axis.test/api/integrations/composio/connect?toolkit=${toolkit}`);
}

// A single-account toolkit (googlecalendar) reconnecting must revoke prior
// rows for that (user, toolkit) — regression for the duplicate-connection bug
// where every reconnect silently added a new ACTIVE row (Composio issues a
// fresh connected_account_id every grant, so the DB's unique constraint on
// (user_id, toolkit, connected_account_id) never matched an existing row).
function mockSupabase(staleRows: { id: string; connected_account_id: string }[]) {
  const upsert = vi.fn(async () => ({ error: null }));
  // Real route: .delete().eq("user_id", ...).in("id", ...) — ONE eq, then in.
  const deleteIn = vi.fn(async () => ({ error: null }));
  const deleteEq1 = vi.fn(() => ({ in: deleteIn }));
  const deleteQuery = vi.fn(() => ({ eq: deleteEq1 }));
  // Real route: .select(...).eq("user_id", ...).eq("toolkit", ...).neq(...) — TWO eq's, then neq.
  const selectNeq = vi.fn(async () => ({ data: staleRows, error: null }));
  const selectEq2 = vi.fn(() => ({ neq: selectNeq }));
  const selectEq1 = vi.fn(() => ({ eq: selectEq2 }));
  const select = vi.fn(() => ({ eq: selectEq1 }));

  from.mockReturnValue({ select, delete: deleteQuery, upsert });
  return { upsert, deleteIn, deleteEq1 };
}

describe("GET /api/integrations/composio/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "user_1" } } });
    getOrCreateAuthConfig.mockResolvedValue("auth_config_1");
    initiateConnection.mockResolvedValue({
      connectedAccountId: "ca_new",
      redirectUrl: "https://composio.example/authorize",
      status: "INITIATED",
    });
  });

  it("revokes prior connections for a single-account toolkit before recording the new one", async () => {
    const { deleteIn, upsert } = mockSupabase([
      { id: "row_old", connected_account_id: "ca_old" },
    ]);
    deleteConnectedAccount.mockResolvedValueOnce(undefined);

    const res = await GET(request("googlecalendar"));

    expect(res.status).toBe(307); // redirect
    expect(deleteConnectedAccount).toHaveBeenCalledWith("ca_old");
    expect(deleteIn).toHaveBeenCalledWith("id", ["row_old"]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ connected_account_id: "ca_new" }),
      expect.anything(),
    );
  });

  it("does not attempt revocation when there are no prior connections", async () => {
    const { deleteIn } = mockSupabase([]);

    await GET(request("strava"));

    expect(deleteConnectedAccount).not.toHaveBeenCalled();
    expect(deleteIn).not.toHaveBeenCalled();
  });

  it("never revokes for multi-account toolkits (gmail/outlook allow multiple mailboxes)", async () => {
    mockSupabase([{ id: "row_old", connected_account_id: "ca_old" }]);

    await GET(request("gmail"));

    // No stale-row lookup at all for multi-account toolkits — select() is only
    // called by the (skipped) dedup branch.
    expect(deleteConnectedAccount).not.toHaveBeenCalled();
  });

  it("preserves rows whose provider revocation fails and returns a partial result", async () => {
    const { deleteIn, upsert } = mockSupabase([{ id: "row_old", connected_account_id: "ca_old" }]);
    deleteConnectedAccount.mockRejectedValueOnce(new Error("provider down"));

    const res = await GET(request("googlecalendar"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("status=partial");
    expect(res.headers.get("location")).toContain("failed=1");
    expect(deleteIn).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ code: "PARTIAL_REVOCATION" }) }),
    );
  });

  it("deletes only successfully revoked rows when cleanup is mixed", async () => {
    const { deleteIn } = mockSupabase([
      { id: "row_ok", connected_account_id: "ca_ok" },
      { id: "row_failed", connected_account_id: "ca_failed" },
    ]);
    deleteConnectedAccount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("provider down"));

    await GET(request("googlecalendar"));

    expect(deleteIn).toHaveBeenCalledWith("id", ["row_ok"]);
  });
});
