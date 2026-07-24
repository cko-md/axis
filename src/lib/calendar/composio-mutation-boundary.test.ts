import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  executeTool: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/integrations/composio", () => ({ executeTool: mocks.executeTool }));

import { createComposioEvent } from "./composio";

describe("calendar create mutation boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a server-authoritative existing provider link without dispatching a duplicate create", async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { gcal_event_id: "existing-google-event", outlook_event_id: null, deleted_at: null },
        error: null,
      }),
    };
    mocks.createAdminClient.mockReturnValue({ from: vi.fn(() => query) });

    await expect(createComposioEvent("googlecalendar", "verified-account", "user-1", {
      id: "event-1",
      title: "Planning",
      start_at: "2026-07-23T12:00:00.000Z",
      end_at: "2026-07-23T12:30:00.000Z",
    })).resolves.toBe("existing-google-event");

    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});
