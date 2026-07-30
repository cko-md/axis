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
