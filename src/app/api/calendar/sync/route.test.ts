import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  listComposioCalendarAccounts: vi.fn(),
  createComposioEvent: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/calendar/composio", () => ({
  listComposioCalendarAccounts: mocks.listComposioCalendarAccounts,
  createComposioEvent: mocks.createComposioEvent,
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  logRouteTiming: vi.fn(),
  timedProviderOperation: vi.fn((_, operation: () => Promise<unknown>) => operation()),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST } from "./route";

function request(eventId = "event-1") {
  return new Request("http://axis.test/api/calendar/sync", {
    method: "POST",
    body: JSON.stringify({ eventId }),
  }) as NextRequest;
}

function createSupabaseMock() {
  const scheduleSelect = {
    eq: vi.fn(() => scheduleSelect),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: "event-1",
        title: "Planning",
        description: null,
        start_at: "2026-07-05T15:00:00.000Z",
        end_at: "2026-07-05T15:30:00.000Z",
      },
      error: null,
    }),
  };
  // .update(patch).eq(...).eq(...) — a thenable chain that resolves { error: null }.
  const updateChain: { eq: ReturnType<typeof vi.fn>; then: (resolve: (v: { error: null }) => void) => void } = {
    eq: vi.fn(() => updateChain),
    then: (resolve) => resolve({ error: null }),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => scheduleSelect),
      update: vi.fn(() => updateChain),
    })),
  };
}

describe("POST /api/calendar/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listComposioCalendarAccounts.mockResolvedValue([]);
    mocks.createComposioEvent.mockResolvedValue("composio-evt");
  });

  it("creates the schedule event through the Composio calendar (Composio-only)", async () => {
    mocks.listComposioCalendarAccounts.mockResolvedValue([
      { provider: "googlecalendar", connectedAccountId: "ca-google-1" },
    ]);
    mocks.createClient.mockResolvedValue(createSupabaseMock());

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mocks.createComposioEvent).toHaveBeenCalledWith(
      "googlecalendar",
      "ca-google-1",
      "user-1",
      expect.anything(),
    );
  });

  it("surfaces Composio calendar discovery failures before provider sync", async () => {
    const composioError = new Error("composio unavailable");
    mocks.createClient.mockResolvedValue(createSupabaseMock());
    mocks.listComposioCalendarAccounts.mockRejectedValue(composioError);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({
      error: "Connected calendar accounts could not be refreshed. Try again in a moment.",
      code: "connection_lookup_failed",
    });
    expect(mocks.captureException).toHaveBeenCalledWith(composioError, {
      tags: { area: "schedule", op: "list_composio_calendar_accounts", route: "/api/calendar/sync" },
      extra: { eventId: "event-1" },
    });
  });
});
