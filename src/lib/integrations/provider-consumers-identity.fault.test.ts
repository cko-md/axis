import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeVerifiedComposioTool: vi.fn(),
  listAuthorizedComposioConnections: vi.fn(),
}));

vi.mock("@/lib/integrations/composio-identity", () => mocks);

import { listComposioEvents } from "@/lib/calendar/composio";
import { listComposioContacts } from "@/lib/contacts/composio";
import {
  getComposioStravaAthlete,
  listComposioStravaActivities,
} from "./strava-composio";

describe("non-Mail Composio consumers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeVerifiedComposioTool.mockResolvedValue({ successful: true, data: { items: [] } });
  });

  it("dispatches Calendar reads through verified local connection authority", async () => {
    await listComposioEvents(
      "googlecalendar",
      "7b2f5034-2089-47c8-91b5-e40df3f693da",
      "axis-user-1",
      "2026-07-01T00:00:00Z",
      "2026-07-31T23:59:59Z",
    );

    expect(mocks.executeVerifiedComposioTool).toHaveBeenCalledWith(expect.objectContaining({
      toolkit: "googlecalendar",
      connectionId: "7b2f5034-2089-47c8-91b5-e40df3f693da",
      toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
    }));
  });

  it("dispatches Contacts and Strava reads through verified local connection authority", async () => {
    const connectionId = "7b2f5034-2089-47c8-91b5-e40df3f693da";
    mocks.executeVerifiedComposioTool
      .mockResolvedValueOnce({ successful: true, data: { connections: [] } })
      .mockResolvedValueOnce({ successful: true, data: { id: 42, firstname: "Axis", lastname: "Runner" } })
      .mockResolvedValueOnce({ successful: true, data: { items: [] } });

    await listComposioContacts(connectionId, "axis-user-1");
    await getComposioStravaAthlete(connectionId, "axis-user-1");
    await listComposioStravaActivities(connectionId, "axis-user-1");

    expect(mocks.executeVerifiedComposioTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      toolkit: "googlecontacts",
      connectionId,
      toolSlug: "GOOGLECONTACTS_LIST_CONNECTIONS",
    }));
    expect(mocks.executeVerifiedComposioTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      toolkit: "strava",
      connectionId,
      toolSlug: "STRAVA_GET_AUTHENTICATED_ATHLETE",
    }));
    expect(mocks.executeVerifiedComposioTool).toHaveBeenNthCalledWith(3, expect.objectContaining({
      toolkit: "strava",
      connectionId,
      toolSlug: "STRAVA_LIST_ATHLETE_ACTIVITIES",
    }));
  });
});
