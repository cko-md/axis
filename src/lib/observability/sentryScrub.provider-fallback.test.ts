import { describe, expect, it } from "vitest";
import type { Breadcrumb, Event } from "@sentry/nextjs";
import {
  guardedSentryBreadcrumb,
  guardedSentryEvent,
} from "./sentryScrub";

const CANARY = "https://private.example/a?token=must-not-leak";
const SAFE_FALLBACK = {
  area: "console",
  provider: "poetrydb",
  transport: "direct",
  operation: "poem_fetch",
  code: "provider_error",
  status: 503,
  outcome: "degraded",
  fallback: true,
} as const;

describe("provider fallback guarded Sentry pipeline", () => {
  it("preserves reviewed breadcrumb diagnostics and drops private metadata", () => {
    const output = guardedSentryBreadcrumb({
      category: "provider.fallback",
      level: "warning",
      message: CANARY,
      data: { ...SAFE_FALLBACK, private_id: CANARY },
    } as Breadcrumb);

    expect(output).toMatchObject({
      category: "provider.fallback",
      level: "warning",
      data: SAFE_FALLBACK,
    });
    expect(output?.message).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
  });

  it("normalizes the producer's string capture tag and preserves degraded context", () => {
    const output = guardedSentryEvent({
      tags: {
        ...SAFE_FALLBACK,
        status: "503",
        fallback: "true",
        private_id: CANARY,
      },
      contexts: {
        providerCall: { ...SAFE_FALLBACK, private_id: CANARY },
      },
    } as unknown as Event);

    expect(output?.tags).toMatchObject({
      ...SAFE_FALLBACK,
      status: 503,
      fallback: true,
    });
    expect(output?.contexts?.providerCall).toMatchObject(SAFE_FALLBACK);
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
  });
});
