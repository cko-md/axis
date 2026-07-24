import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const rpc = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: () => maybeSingle() }) }),
      }),
    }),
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

import { DELETE } from "./route";

describe("calendar external delete containment", () => {
  beforeEach(() => {
    rpc.mockReset();
    maybeSingle.mockResolvedValue({
      data: {
        id: "event-1",
        title: "Protected event",
        start_at: "2026-07-23T12:00:00Z",
        end_at: "2026-07-23T13:00:00Z",
        gcal_event_id: "provider-event-1",
        outlook_event_id: null,
        deleted_at: null,
        external_cleanup_state: "active",
      },
      error: null,
    });
  });

  it("does not tombstone, invoke a provider, or delete locally for an externally linked event", async () => {
    const request = new NextRequest("http://axis.test/api/calendar/event/event-1", {
      method: "DELETE",
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" },
    });
    const response = await DELETE(request, { params: Promise.resolve({ id: "event-1" }) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "External calendar deletion is temporarily unavailable while provider verification is completed. Nothing was deleted.",
      state: "failed_before_dispatch",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps a local-looking event when calendar creation still needs reconciliation", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        id: "event-1",
        title: "Pending event",
        start_at: "2026-07-23T12:00:00Z",
        end_at: "2026-07-23T13:00:00Z",
        gcal_event_id: null,
        outlook_event_id: null,
        deleted_at: null,
        external_cleanup_state: "active",
      },
      error: null,
    });
    rpc.mockResolvedValueOnce({ data: { outcome: "calendar_creation_linked" }, error: null });
    const request = new NextRequest("http://axis.test/api/calendar/event/event-1", {
      method: "DELETE",
      headers: { "idempotency-key": "123e4567-e89b-42d3-a456-426614174000" },
    });

    const response = await DELETE(request, { params: Promise.resolve({ id: "event-1" }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Calendar creation outcome is pending; nothing was deleted.",
      state: "reconciliation_required",
    });
  });
});
