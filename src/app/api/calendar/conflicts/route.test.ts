import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createClient: vi.fn(),
  listComposioCalendarAccounts: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/calendar/composio", () => ({
  listComposioCalendarAccounts: mocks.listComposioCalendarAccounts,
  queryFreeBusy: vi.fn(),
  findFreeSlots: vi.fn(),
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  logRouteTiming: vi.fn(),
  timedProviderOperation: vi.fn((_, operation: () => Promise<unknown>) => operation()),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST } from "./route";

function request() {
  return new Request("http://axis.test/api/calendar/conflicts", {
    method: "POST",
    body: JSON.stringify({
      start_at: "2026-07-15T15:00:00.000Z",
      end_at: "2026-07-15T15:30:00.000Z",
    }),
  }) as NextRequest;
}

describe("POST /api/calendar/conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            lt: vi.fn(() => ({
              gt: vi.fn().mockResolvedValue({
                data: [{ id: "local-1", title: "Planning" }],
                error: null,
              }),
            })),
          })),
        })),
      })),
    });
  });

  it("surfaces Composio account discovery failures without false external coverage", async () => {
    const discoveryError = new Error("database unavailable");
    mocks.listComposioCalendarAccounts.mockRejectedValue(discoveryError);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toEqual({
      conflict: true,
      conflictingTitles: ["Planning"],
      suggestions: [],
      externalChecked: false,
      partial: true,
      errors: [{
        source: "google",
        transport: "composio",
        message: "Google Calendar conflicts could not be checked.",
      }],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(discoveryError, {
      tags: { area: "schedule", route: "/api/calendar/conflicts", op: "list_composio_accounts" },
    });
  });
});
