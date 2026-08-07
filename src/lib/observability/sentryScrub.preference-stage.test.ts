import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { scrubSentryEventStrict } from "./sentryScrub";

describe("preference failure telemetry vocabulary", () => {
  it("preserves only the reviewed route transport and fixed failure stages", () => {
    for (const stage of [
      "request",
      "response-body",
      "response-status",
      "contract",
      "rls",
    ]) {
      const event = scrubSentryEventStrict({
        tags: {
          area: "profile",
          provider: "supabase",
          operation: "load",
          code: "PROFILE_LOAD_FAILED",
          status: 503,
          transport: "route",
          stage,
        },
      } as Event);
      expect(event.tags).toEqual(expect.objectContaining({
        area: "profile",
        provider: "supabase",
        operation: "load",
        code: "PROFILE_LOAD_FAILED",
        status: 503,
        transport: "route",
        stage,
      }));
    }
  });

  it("drops unreviewed transport and stage strings", () => {
    const event = scrubSentryEventStrict({
      tags: {
        area: "profile",
        operation: "load",
        code: "PROFILE_LOAD_FAILED",
        transport: "private-provider-path",
        stage: "private-stage",
      },
    } as Event);
    expect(event.tags).not.toHaveProperty("transport");
    expect(event.tags).not.toHaveProperty("stage");
  });
});
