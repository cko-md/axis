import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { createEnvelope, serializeEnvelope, type TransactionEvent } from "@sentry/core";

import { scrubSentryBreadcrumb, scrubSentryEvent, scrubSentrySpan, scrubSentryTransaction } from "./sentryScrub";

function envelopeText(item: unknown, type: "event" | "transaction" = "event") {
  const serialized = serializeEnvelope(createEnvelope({}, [[{ type }, item] as never]));
  return typeof serialized === "string" ? serialized : new TextDecoder().decode(serialized);
}

describe("scrubSentryEvent", () => {
  it("redacts sensitive request, user, extra, and exception data", () => {
    const event: Event = {
      message: "Failed for owner@example.com",
      request: {
        url: "https://axis.local/mail?email=owner@example.com",
        headers: {
          Authorization: "Bearer secret-token",
          Cookie: "session=secret",
          "x-request-id": "req_123",
        },
        cookies: {
          session: "secret",
        },
        data: {
          subject: "Quarterly update",
          mailBody: "<p>Private message</p>",
          nested: {
            accessToken: "secret-token",
            sender: "sender@example.com",
          },
        },
        query_string: {
          account: "owner@example.com",
        },
      },
      user: {
        id: "user_123",
        email: "owner@example.com",
        ip_address: "127.0.0.1",
        username: "owner@example.com",
      },
      extra: {
        provider: "gmail",
        refreshToken: "secret-refresh-token",
        note: "Contact owner@example.com",
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "Provider failed for owner@example.com",
          },
        ],
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.message).toBe("Failed for [REDACTED_EMAIL]");
    expect(scrubbed.request?.url).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.Authorization).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.Cookie).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.["x-request-id"]).toBe("req_123");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.user).toMatchObject({
      id: "user_123",
      username: "[REDACTED_EMAIL]",
    });
    expect(scrubbed.user?.email).toBeUndefined();
    expect(scrubbed.user?.ip_address).toBeUndefined();
    expect(scrubbed.extra).toMatchObject({
      provider: "gmail",
      refreshToken: "[REDACTED]",
      note: "Contact [REDACTED_EMAIL]",
    });
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      "Provider failed for [REDACTED_EMAIL]",
    );
  });

  it("removes complete WebAuthn request bodies and nested authentication artifacts", () => {
    const event: Event = {
      request: {
        url: "https://axis.local/api/auth/passkey/authenticate?action=verify",
        data: {
          challengeId: "challenge-secret",
          response: {
            id: "credential-secret",
            rawId: "credential-secret",
            response: {
              clientDataJSON: "client-data",
              authenticatorData: "authenticator-data",
              signature: "assertion-signature",
              userHandle: "user-handle",
            },
          },
        },
      },
      extra: {
        challenge: "opaque-challenge",
        credentialId: "credential-secret",
        safeCode: "PASSKEY_COMMIT_FAILED",
      },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request?.data).toBe("[REDACTED]");
    expect(scrubbed.extra).toEqual({
      challenge: "[REDACTED]",
      credentialId: "[REDACTED]",
      safeCode: "PASSKEY_COMMIT_FAILED",
    });
  });

  it("also removes approval step-up WebAuthn request bodies", () => {
    const event: Event = {
      request: {
        url: "https://axis.local/api/approvals/approval_1/step-up?action=verify",
        data: { response: { signature: "secret" } },
      },
    };

    expect(scrubSentryEvent(event).request?.data).toBe("[REDACTED]");
  });

  it("removes request targets and nested URL-bearing data from every event surface", () => {
    const canary = "https://private.example/internal/path?token=must-not-leak#fragment";
    const event = scrubSentryEvent({
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

    expect(event.tags).toMatchObject({ operation: "cached_feed", code: "SAFE_FETCH_TIMEOUT", provider: "youtube", feedUrl: "[REDACTED]" });
    expect(event.extra).toMatchObject({ nested: { uri: "[REDACTED]", href: "[REDACTED]", feedUrls: "[REDACTED]" } });
    expect(event.contexts).toMatchObject({ upstream: { targetUrl: "[REDACTED]" } });
    expect(event.breadcrumbs?.[0]?.data).toMatchObject({ url: "[REDACTED]", href: "[REDACTED]", feed: "[REDACTED]" });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("internal/path");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("fragment");
  });

  it("scrubs transaction and native HTTP span payloads before their envelopes are serialized", () => {
    const canary = "https://private.example/internal/path?token=must-not-leak#fragment";
    const transaction = scrubSentryTransaction({
      type: "transaction",
      transaction: "GET /api/feeds/cached",
      transaction_info: { source: "route" },
      request: { url: canary, data: { feedUrls: [canary] }, query_string: { url: canary } },
      contexts: { trace: { http: { url: canary } } },
      spans: [{
        trace_id: "0".repeat(32), span_id: "1".repeat(16), start_timestamp: 1,
        data: {
          "http.url": canary, "url.full": canary, "url.query": "token=must-not-leak", "http.target": "/internal/path?token=must-not-leak",
          "net.peer.ip": "203.0.113.77", "net.peer.name": "private.example", "net.peer.host": "private.example", "server.address": "203.0.113.88",
          "network.peer.address": "203.0.113.99", "network.peer.port": 8443,
          "http.route": "/api/feeds/cached", operation: "cached_feed", code: "SAFE_FETCH_TIMEOUT", provider: "youtube",
        },
        description: `GET ${canary}`,
      }],
    } as unknown as TransactionEvent);

    expect(transaction.transaction).toBe("GET /api/feeds/cached");
    expect(transaction.spans?.[0]?.data).toMatchObject({
      "http.url": "[REDACTED]", "url.full": "[REDACTED]", "url.query": "[REDACTED]", "http.target": "[REDACTED]",
      "net.peer.ip": "[REDACTED]", "net.peer.name": "[REDACTED]", "net.peer.host": "[REDACTED]", "server.address": "[REDACTED]",
      "network.peer.address": "[REDACTED]", "network.peer.port": "[REDACTED]",
      "http.route": "/api/feeds/cached", operation: "cached_feed", code: "SAFE_FETCH_TIMEOUT", provider: "youtube",
    });
    expect(transaction.spans?.[0]?.description).toBe("[REDACTED]");
    const serialized = envelopeText(transaction);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("internal/path");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("fragment");
    expect(serialized).not.toContain("203.0.113.");
    expect(serialized).not.toContain("8443");
  });

  it("scrubs standalone span envelopes and breadcrumbs before capture", () => {
    const canary = "https://private.example/internal/path?token=must-not-leak";
    const span = scrubSentrySpan({
      trace_id: "0".repeat(32), span_id: "1".repeat(16), start_timestamp: 1,
      data: { "http.url": canary, nested: { href: canary }, provider: "youtube", operation: "reader_extract", security: "safe", feedback: "safe", transport: "direct" } as never,
      description: `GET ${canary}`,
    });
    const breadcrumb = scrubSentryBreadcrumb({ category: "http", message: canary, data: { url: canary, operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT" } });
    const networkBreadcrumb = scrubSentryBreadcrumb({
      category: "fetch",
      data: { url: canary, headers: { authorization: "Bearer must-not-leak", cookie: "session=must-not-leak", referer: canary } },
    });
    const serialized = `${envelopeText(span)}${JSON.stringify(breadcrumb)}${JSON.stringify(networkBreadcrumb)}`;
    expect(span.data).toMatchObject({ "http.url": "[REDACTED]", nested: { href: "[REDACTED]" }, provider: "youtube", operation: "reader_extract", security: "safe", feedback: "safe", transport: "direct" });
    expect(breadcrumb.data).toMatchObject({ url: "[REDACTED]", operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT" });
    expect(breadcrumb.message).toBe("[REDACTED]");
    expect(networkBreadcrumb.data).toMatchObject({ url: "[REDACTED]", headers: { authorization: "[REDACTED]", cookie: "[REDACTED]", referer: "[REDACTED]" } });
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
    const error = scrubSentryEvent({ type: "error", breadcrumbs: [breadcrumb] } as unknown as Event);
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
