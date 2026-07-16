import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { triggerWebhook, validateMakeWebhookUrl } from "./make";

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("Make webhook adapter", () => {
  it("accepts only opaque HTTPS Make hook URLs", () => {
    expect(validateMakeWebhookUrl("https://hook.us2.make.com/opaque-token").ok).toBe(true);
    expect(validateMakeWebhookUrl("http://hook.us2.make.com/opaque-token").ok).toBe(false);
    expect(validateMakeWebhookUrl("https://example.com/opaque-token").ok).toBe(false);
    expect(validateMakeWebhookUrl("https://hook.us2.make.com").ok).toBe(false);
    expect(validateMakeWebhookUrl("https://user:pass@hook.us2.make.com/opaque-token").ok).toBe(false);
  });

  it("returns a typed receipt without reading the response body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("secret response", { status: 202 }));
    global.fetch = fetchMock;

    const result = await triggerWebhook("https://hook.us2.make.com/opaque-token", { kind: "daily_brief" });

    expect(result).toEqual({ ok: true, data: { accepted: true, status: 202 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("maps HTTP failures without exposing provider response content", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("token=provider-secret", { status: 503 }),
    );

    const result = await triggerWebhook("https://hook.us2.make.com/opaque-token", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "provider_error",
        message: "Make webhook rejected delivery",
        provider: "make",
        status: 503,
      });
      expect(JSON.stringify(result)).not.toContain("provider-secret");
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a rejected destination", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const result = await triggerWebhook("https://127.0.0.1/internal", {});

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a generic network failure and never retries a write", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("opaque-token leaked by fetch"));
    global.fetch = fetchMock;

    const result = await triggerWebhook("https://hook.us2.make.com/opaque-token", {});

    expect(result).toEqual({
      ok: false,
      error: {
        code: "network",
        message: "Make webhook delivery failed",
        retryable: true,
        provider: "make",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
