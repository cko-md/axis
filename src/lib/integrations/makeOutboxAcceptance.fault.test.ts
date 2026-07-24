import { describe, expect, it } from "vitest";
import {
  isMakeOutboxReplayable,
  type MakeOutboxMetadataRow,
} from "./makeOutbox";

describe("Make acceptance is not delivery", () => {
  it("does not make an accepted row replayable or delivered", () => {
    const row: MakeOutboxMetadataRow = {
      id: "delivery-1",
      provider: "make",
      event_type: "daily_brief",
      status: "accepted",
      attempt_count: 1,
      last_error_code: "delivery_confirmation_pending",
      last_http_status: 202,
      locked_at: null,
      accepted_at: "2026-07-23T12:00:00.000Z",
      delivered_at: null,
      created_at: "2026-07-23T12:00:00.000Z",
      updated_at: "2026-07-23T12:00:00.000Z",
    };

    expect(isMakeOutboxReplayable(row)).toBe(false);
    expect(row.status).not.toBe("delivered");
    expect(row.delivered_at).toBeNull();
  });
});
