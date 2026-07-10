import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: vi.fn(),
  };
});

import { executeTool } from "@/lib/integrations/composio";
import { listComposioEvents } from "./composio";

const executeToolMock = vi.mocked(executeTool);

describe("listComposioEvents()", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
    executeToolMock.mockResolvedValue({ successful: true, data: { value: [] } });
  });

  it("includes all-day Outlook events in the Composio filter", async () => {
    await listComposioEvents(
      "outlook",
      "ca_outlook",
      "user_1",
      "2026-07-01T00:00:00Z",
      "2026-07-31T23:59:59Z",
    );

    expect(executeToolMock).toHaveBeenCalledWith(expect.objectContaining({
      toolSlug: "OUTLOOK_LIST_EVENTS",
      arguments: expect.objectContaining({
        filter:
          "(start/dateTime ge '2026-07-01T00:00:00Z' and start/dateTime le '2026-07-31T23:59:59Z')" +
          " or (start/date ge '2026-07-01' and start/date le '2026-07-31')",
        orderby: ["start/dateTime", "start/date"],
      }),
    }));
  });
});

import {
  GOOGLECALENDAR_COMPOSIO_TOOLS,
  OUTLOOK_CALENDAR_COMPOSIO_TOOLS,
} from "@/lib/integrations/composio-calendar-tools";
import { normalizeOutlookCalEvent } from "./composio";

describe("calendar composio tool registry", () => {
  it("uses verified Google and Outlook calendar slugs", () => {
    expect(GOOGLECALENDAR_COMPOSIO_TOOLS).toEqual([
      "GOOGLECALENDAR_EVENTS_LIST",
      "GOOGLECALENDAR_CREATE_EVENT",
      "GOOGLECALENDAR_DELETE_EVENT",
      "GOOGLECALENDAR_FREE_BUSY_QUERY",
      "GOOGLECALENDAR_FIND_FREE_SLOTS",
      "GOOGLECALENDAR_LIST_CALENDARS",
    ]);
    expect(OUTLOOK_CALENDAR_COMPOSIO_TOOLS).toEqual([
      "OUTLOOK_LIST_EVENTS",
      "OUTLOOK_CALENDAR_CREATE_EVENT",
      "OUTLOOK_DELETE_EVENT",
    ]);
  });
});

describe("normalizeOutlookCalEvent()", () => {
  it("preserves all-day events that only expose date fields", () => {
    const event = normalizeOutlookCalEvent({
      id: "evt-all-day",
      subject: "Holiday",
      isAllDay: true,
      start: { date: "2026-07-04" },
      end: { date: "2026-07-05" },
    });

    expect(event).toMatchObject({
      externalId: "evt-all-day",
      title: "Holiday",
      start_at: "2026-07-04T00:00:00Z",
      end_at: "2026-07-05T00:00:00Z",
      all_day: true,
    });
  });

  it("formats timed Outlook events without double-appending Z", () => {
    const event = normalizeOutlookCalEvent({
      id: "evt-timed",
      subject: "Standup",
      start: { dateTime: "2026-07-08T15:00:00Z" },
      end: { dateTime: "2026-07-08T15:30:00Z" },
    });

    expect(event).toMatchObject({
      start_at: "2026-07-08T15:00:00Z",
      end_at: "2026-07-08T15:30:00Z",
      all_day: false,
    });
  });
});
