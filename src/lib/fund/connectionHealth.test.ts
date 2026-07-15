import { describe, expect, it } from "vitest";
import { deriveConnectionHealth } from "./connectionHealth";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe("deriveConnectionHealth", () => {
  it("separates configured providers from linked user connections", () => {
    expect(
      deriveConnectionHealth({
        provider: "public",
        label: "Public",
        configured: true,
        now: NOW,
      }),
    ).toMatchObject({
      status: "configured",
      statusLabel: "Configured",
      provenanceLabel: "Server-side provider credentials",
      freshness: "unknown",
    });
  });

  it("marks linked provider rows as connected without requiring a fresh timestamp", () => {
    expect(
      deriveConnectionHealth({
        provider: "plaid",
        label: "Plaid",
        configured: true,
        linked: true,
        now: NOW,
      }),
    ).toMatchObject({
      status: "connected",
      statusLabel: "Connected",
      provenanceLabel: "User-linked provider",
      freshness: "unknown",
    });
  });

  it("classifies linked provider provenance freshness when a sync timestamp exists", () => {
    expect(
      deriveConnectionHealth({
        provider: "plaid",
        label: "Plaid",
        configured: true,
        linked: true,
        lastSyncedAt: new Date(NOW - 60_000).toISOString(),
        now: NOW,
      }),
    ).toMatchObject({
      status: "connected",
      tone: "positive",
      freshness: "fresh",
      provenanceLabel: "User-linked provider record",
    });
  });

  it("does not present unconfigured providers as live", () => {
    expect(
      deriveConnectionHealth({
        provider: "polygon",
        label: "Polygon",
        configured: false,
        linked: true,
        lastSyncedAt: new Date(NOW).toISOString(),
        now: NOW,
      }),
    ).toMatchObject({
      status: "not_configured",
      statusLabel: "Not configured",
      freshness: "unknown",
      lastSyncedAt: null,
    });
  });

  it("surfaces provider errors as degraded with last-known freshness", () => {
    expect(
      deriveConnectionHealth({
        provider: "plaid",
        label: "Plaid",
        configured: true,
        linked: true,
        error: true,
        lastSyncedAt: new Date(NOW - 25 * 3_600_000).toISOString(),
        now: NOW,
      }),
    ).toMatchObject({
      status: "degraded",
      statusLabel: "Needs attention",
      freshness: "stale",
      provenanceLabel: "Last known provider data",
    });
  });
});
