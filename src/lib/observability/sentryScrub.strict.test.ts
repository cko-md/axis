import { describe, expect, it } from "vitest";
import { createEnvelope, serializeEnvelope, type TransactionEvent } from "@sentry/core";
import type { Event } from "@sentry/nextjs";

import {
  scrubSentryBreadcrumb,
  scrubSentryEventStrict,
  scrubSentrySpan,
  scrubSentryTransaction,
} from "./sentryScrub";

function envelopeText(item: unknown, type: "event" | "transaction" = "event") {
  const serialized = serializeEnvelope(createEnvelope({}, [[{ type }, item] as never]));
  return typeof serialized === "string" ? serialized : new TextDecoder().decode(serialized);
}

describe("strict Sentry transport scrubbing", () => {
  it("removes request targets, payloads, and nested target-bearing metadata", () => {
    const canary = "https://private.example/internal/path?token=must-not-leak#fragment-secret";
    const event = scrubSentryEventStrict({
      request: {
        url: canary,
        headers: { Referer: canary, Cookie: "session=must-not-leak" },
        query_string: { url: canary },
        data: { feedUrls: [canary] },
      },
      tags: { operation: "cached_feed", code: "SAFE_FETCH_TIMEOUT", provider: "youtube", feedUrl: canary },
      extra: { nested: { uri: canary, href: canary, feedUrls: [canary] } },
      contexts: { upstream: { targetUrl: canary } },
      breadcrumbs: [{ category: "safe-fetch", data: { url: canary, href: canary, feed: canary } }],
    } as Event);

    expect(event.request).toMatchObject({ url: "[REDACTED]" });
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.tags).toMatchObject({ operation: "cached_feed", code: "SAFE_FETCH_TIMEOUT", provider: "youtube", feedUrl: "[REDACTED]" });
    expect(event.extra).toMatchObject({ nested: { uri: "[REDACTED]", href: "[REDACTED]", feedUrls: "[REDACTED]" } });
    expect(event.contexts).toMatchObject({ upstream: { targetUrl: "[REDACTED]" } });
    expect(event.breadcrumbs?.[0]?.data).toMatchObject({ url: "[REDACTED]", href: "[REDACTED]", feed: "[REDACTED]" });
    const serialized = envelopeText(event);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("internal/path");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("fragment-secret");
  });

  it("removes native HTTP target, peer, query, and fragment attributes from transaction envelopes", () => {
    const canary = "https://private.example/internal/path?token=must-not-leak#fragment-secret";
    const transaction = scrubSentryTransaction({
      type: "transaction",
      transaction: "GET /api/feeds/cached",
      transaction_info: { source: "route" },
      request: { url: canary, data: { feedUrls: [canary] }, query_string: { url: canary } },
      contexts: { trace: { http: { url: canary } } },
      spans: [{
        trace_id: "0".repeat(32),
        span_id: "1".repeat(16),
        start_timestamp: 1,
        data: {
          "http.url": canary,
          "url.full": canary,
          "url.query": "token=must-not-leak",
          "http.query": "token=must-not-leak",
          "http.fragment": "fragment-secret",
          "http.search": "?token=must-not-leak",
          "http.search_params": "token=must-not-leak",
          "http.hash": "#fragment-secret",
          "http.target": "/internal/path?token=must-not-leak",
          "net.peer.ip": "203.0.113.77",
          "net.peer.name": "private.example",
          "net.peer.host": "private.example",
          "server.address": "203.0.113.88",
          "network.peer.address": "203.0.113.99",
          "network.peer.port": 8443,
          "http.route": "/api/feeds/cached",
          operation: "cached_feed",
          code: "SAFE_FETCH_TIMEOUT",
          provider: "youtube",
        },
        description: `GET ${canary}`,
      }],
    } as unknown as TransactionEvent);

    expect(transaction.transaction).toBe("GET /api/feeds/cached");
    expect(transaction.spans?.[0]?.data).toMatchObject({
      "http.url": "[REDACTED]",
      "url.full": "[REDACTED]",
      "url.query": "[REDACTED]",
      "http.query": "[REDACTED]",
      "http.fragment": "[REDACTED]",
      "http.search": "[REDACTED]",
      "http.search_params": "[REDACTED]",
      "http.hash": "[REDACTED]",
      "http.target": "[REDACTED]",
      "net.peer.ip": "[REDACTED]",
      "net.peer.name": "[REDACTED]",
      "net.peer.host": "[REDACTED]",
      "server.address": "[REDACTED]",
      "network.peer.address": "[REDACTED]",
      "network.peer.port": "[REDACTED]",
      "http.route": "/api/feeds/cached",
      operation: "cached_feed",
      code: "SAFE_FETCH_TIMEOUT",
      provider: "youtube",
    });
    expect(transaction.spans?.[0]?.description).toBe("[REDACTED]");
    const serialized = envelopeText(transaction, "transaction");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("internal/path");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("fragment-secret");
    expect(serialized).not.toContain("203.0.113.");
    expect(serialized).not.toContain("8443");
  });

  it("preserves safe diagnostics while scrubbing standalone spans and breadcrumbs", () => {
    const canary = "https://private.example/internal/path?token=must-not-leak";
    const span = scrubSentrySpan({
      trace_id: "0".repeat(32),
      span_id: "1".repeat(16),
      start_timestamp: 1,
      data: {
        "http.url": canary,
        nested: { href: canary },
        provider: "youtube",
        operation: "reader_extract",
        security: "safe",
        feedback: "safe",
        transport: "direct",
      } as never,
      description: `GET ${canary}`,
    });
    const breadcrumb = scrubSentryBreadcrumb({
      category: "http",
      message: canary,
      data: { url: canary, operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT" },
    });
    const serialized = `${envelopeText(span)}${JSON.stringify(breadcrumb)}`;

    expect(span.data).toMatchObject({
      "http.url": "[REDACTED]",
      nested: { href: "[REDACTED]" },
      provider: "youtube",
      operation: "reader_extract",
      security: "safe",
      feedback: "safe",
      transport: "direct",
    });
    expect(breadcrumb.data).toMatchObject({ url: "[REDACTED]", operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT" });
    expect(breadcrumb.message).toBe("[REDACTED]");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("redacts a complete parenthesized URL in generic strings, breadcrumbs, and spans", () => {
    const canary = "https://private.example/a(path)/detail?token=must-not-leak#fragment-secret";
    const event = scrubSentryEventStrict({
      extra: { diagnostic: `fetch failed for ${canary} after retry` },
      breadcrumbs: [{ category: "safe-fetch", data: { diagnostic: `upstream=${canary}` } }],
    } as Event);
    const span = scrubSentrySpan({
      trace_id: "0".repeat(32),
      span_id: "1".repeat(16),
      start_timestamp: 1,
      data: { diagnostic: `GET ${canary}` } as never,
      description: `GET ${canary}`,
    });
    const serialized = `${envelopeText(event)}${envelopeText(span)}`;

    for (const fragment of ["private.example", "a(path)", "token=must-not-leak", "fragment-secret"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(serialized).toContain("[REDACTED]");
    expect(span.description).toBe("[REDACTED]");
  });

  it("scrubs nested exception metadata and fingerprints without leaking URL suffixes", () => {
    const canary = "https://private.example/a(path)?token=must-not-leak#fragment-secret";
    const event = scrubSentryEventStrict({
      exception: {
        values: [{
          type: canary,
          value: `fetch failed: ${canary}.`,
          mechanism: { type: "generic", data: { diagnostic: `upstream ${canary}.` } },
          stacktrace: {
            frames: [{
              filename: canary,
              abs_path: `${canary}.`,
              function: `load(${canary}).`,
            }],
          },
        }],
      },
      fingerprint: ["safe-fetch", canary, `retry:${canary}.`],
    } as unknown as Event);
    const serialized = envelopeText(event);

    for (const fragment of ["private.example", "a(path)", "token=must-not-leak", "fragment-secret"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(event.exception?.values?.[0]).toMatchObject({
      type: "[REDACTED]",
      value: "[REDACTED]",
      mechanism: { type: "generic", data: { diagnostic: "[REDACTED]" } },
      stacktrace: {
        frames: [{
          filename: "[REDACTED]",
          abs_path: "[REDACTED]",
          function: "[REDACTED]",
        }],
      },
    });
    expect(event.fingerprint).toEqual(["safe-fetch", "[REDACTED]", "[REDACTED]"]);
  });

  it("scrubs path-only targets in every standard exception field and fingerprint", () => {
    const canary = "/internal/path?token=must-not-leak#fragment-secret";
    const event = scrubSentryEventStrict({
      exception: {
        values: [{
          type: `FetchFailure ${canary}`,
          value: `fetch failed: ${canary}`,
          mechanism: { type: "generic", data: { diagnostic: `upstream=${canary}` } },
          stacktrace: {
            frames: [{
              filename: canary,
              abs_path: `https://axis.test${canary}`,
              function: `load(${canary})`,
            }],
          },
        }],
      },
      fingerprint: ["safe-fetch", canary, `retry:${canary}`],
    } as unknown as Event);
    const serialized = envelopeText(event);

    for (const fragment of ["internal/path", "token=must-not-leak", "fragment-secret"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(event.exception?.values?.[0]).toMatchObject({
      type: "[REDACTED]",
      value: "[REDACTED]",
      mechanism: { type: "generic", data: { diagnostic: "[REDACTED]" } },
      stacktrace: { frames: [{ filename: "[REDACTED]", abs_path: "[REDACTED]", function: "[REDACTED]" }] },
    });
    expect(event.fingerprint).toEqual(["safe-fetch", "[REDACTED]", "[REDACTED]"]);
  });

  it("scrubs path-only targets across every strict event, breadcrumb, and span string surface", () => {
    const canary = "/internal/path?token=must-not-leak#fragment-secret";
    const event = scrubSentryEventStrict({
      extra: { diagnostic: `extra=${canary}` },
      contexts: { operation: { diagnostic: `context=${canary}` } },
      tags: { diagnostic: `tag=${canary}`, operation: "cached_feed" },
      breadcrumbs: [{ category: "safe-fetch", data: { diagnostic: `breadcrumb=${canary}` } }],
      exception: {
        values: [{
          type: `FetchFailure ${canary}`,
          value: canary,
          mechanism: { type: "generic", data: { diagnostic: canary } },
          stacktrace: { frames: [{ filename: canary, abs_path: canary, function: `load(${canary})` }] },
        }],
      },
      fingerprint: ["safe-fetch", canary],
    } as unknown as Event);
    const span = scrubSentrySpan({
      trace_id: "0".repeat(32),
      span_id: "1".repeat(16),
      start_timestamp: 1,
      data: { diagnostic: `span=${canary}`, operation: "cached_feed" } as never,
      links: [{
        trace_id: "2".repeat(32),
        span_id: "3".repeat(16),
        attributes: { diagnostic: `link=${canary}` },
      }],
    });
    const serialized = `${envelopeText(event)}${envelopeText(span)}`;

    for (const fragment of ["internal/path", "token=must-not-leak", "fragment-secret"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(event.extra).toEqual({ diagnostic: "[REDACTED]" });
    expect(event.contexts).toEqual({ operation: { diagnostic: "[REDACTED]" } });
    expect(event.tags).toMatchObject({ diagnostic: "[REDACTED]", operation: "cached_feed" });
    expect(event.breadcrumbs?.[0]?.data).toEqual({ diagnostic: "[REDACTED]" });
    expect(event.fingerprint).toEqual(["safe-fetch", "[REDACTED]"]);
    expect(span.data).toMatchObject({ diagnostic: "[REDACTED]", operation: "cached_feed" });
    expect(span.links?.[0]?.attributes).toEqual({ diagnostic: "[REDACTED]" });
  });

  it("preserves only conservative SDK-normalized http.route templates", () => {
    const scrubRoute = (route: string) => scrubSentrySpan({
      trace_id: "0".repeat(32),
      span_id: "1".repeat(16),
      start_timestamp: 1,
      data: { "http.route": route } as never,
    }).data?.["http.route"];

    expect(scrubRoute("/api/feeds/cached")).toBe("/api/feeds/cached");
    for (const unsafeRoute of [
      "/api/feeds/cached?token=must-not-leak",
      "/api/feeds/cached#fragment-secret",
      "https://private.example/internal",
      "/api/%2Finternal",
      "/api\\internal",
      "/api feeds/cached",
      "//private.example/internal",
    ]) {
      expect(scrubRoute(unsafeRoute)).toBe("[REDACTED]");
    }
  });

  it("removes path-only navigation breadcrumb canaries from error and transaction envelopes", () => {
    const canary = "/internal/path?token=must-not-leak#fragment";
    const breadcrumb = {
      category: "navigation",
      message: `Navigated to ${canary}`,
      data: {
        previous: canary,
        current: canary,
        path: canary,
        description: `GET ${canary}`,
        operation: "cached_feed",
        code: "SAFE_FETCH_TIMEOUT",
        provider: "youtube",
        transport: "direct",
      },
    };
    const error = scrubSentryEventStrict({ type: "error", breadcrumbs: [breadcrumb] } as unknown as Event);
    const transaction = scrubSentryTransaction({
      type: "transaction",
      transaction: "GET /api/feeds/cached",
      transaction_info: { source: "route" },
      breadcrumbs: [breadcrumb],
    } as unknown as TransactionEvent);
    const serialized = `${envelopeText(error)}${envelopeText(transaction, "transaction")}`;

    expect(serialized).not.toContain("internal/path");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("fragment");
    expect(serialized).toContain("cached_feed");
    expect(serialized).toContain("SAFE_FETCH_TIMEOUT");
    expect(serialized).toContain("youtube");
    expect(serialized).toContain("direct");
  });
});
