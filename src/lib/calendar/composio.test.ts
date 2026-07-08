import { describe, expect, it } from "vitest";
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
