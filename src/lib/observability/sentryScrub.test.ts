import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";

import { scrubSentryEvent } from "./sentryScrub";

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
});
