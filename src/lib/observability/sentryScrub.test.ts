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
    expect(scrubbed.request?.url).toBe("https://axis.local/mail?email=[REDACTED_EMAIL]");
    expect(scrubbed.request?.headers?.Authorization).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.Cookie).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.["x-request-id"]).toBe("req_123");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toMatchObject({
      subject: "Quarterly update",
      mailBody: "[REDACTED]",
      nested: {
        accessToken: "[REDACTED]",
        sender: "[REDACTED_EMAIL]",
      },
    });
    expect(scrubbed.request?.query_string).toEqual({ account: "[REDACTED_EMAIL]" });
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
});
