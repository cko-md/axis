import { describe, expect, it } from "vitest";
import {
  ComposioCalendarMutationDisabledError,
  createComposioEvent,
  deleteComposioEvent,
} from "./composio";

describe("Calendar Composio provider-identity containment", () => {
  it("fails closed before a create dispatch can be attempted", async () => {
    await expect(createComposioEvent(
      "googlecalendar",
      "8b3e4c9d-a6f8-4ce4-b410-c3ef28228cd1",
      "axis-user-1",
      {
        title: "Must not leave AXIS",
        start_at: "2026-07-23T15:00:00.000Z",
        end_at: "2026-07-23T15:30:00.000Z",
      },
    )).rejects.toBeInstanceOf(ComposioCalendarMutationDisabledError);
  });

  it("fails closed before a delete dispatch can be attempted", async () => {
    await expect(deleteComposioEvent(
      "outlook",
      "8b3e4c9d-a6f8-4ce4-b410-c3ef28228cd1",
      "axis-user-1",
      "event-1",
    )).rejects.toMatchObject({ code: "provider_mutations_disabled", status: 403 });
  });
});
