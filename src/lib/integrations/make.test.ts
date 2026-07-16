import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { optionalEnv } from "@/lib/env";
import {
  getScenario,
  listScenarios,
  runScenario,
  setScenarioActive,
  triggerWebhook,
  validateMakeWebhookUrl,
} from "./make";

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn() }));

const originalFetch = global.fetch;
const optionalEnvMock = vi.mocked(optionalEnv);
let env: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  env = {
    MAKE_API_KEY: "private-make-api-key",
    MAKE_TEAM_ID: "42",
  };
  optionalEnvMock.mockImplementation((name) => env[name]);
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
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

describe("Make management adapter", () => {
  const scenario = {
    id: 7,
    name: "Daily brief",
    isActive: true,
    teamId: 42,
  };

  it("fails closed without an API key and does not fetch", async () => {
    env.MAKE_API_KEY = undefined;
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const result = await listScenarios();

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_error",
        message: "Make management API is not configured",
        retryable: false,
        provider: "make",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid team and scenario ids before a network call", async () => {
    env.MAKE_TEAM_ID = "not-a-team";
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const [listed, loaded] = await Promise.all([listScenarios(), getScenario(-1)]);

    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error.code).toBe("invalid_request");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid Make zone before a network call", async () => {
    env.MAKE_ZONE = "https://evil.example/api";
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const result = await listScenarios();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "provider_error",
        message: "Make management API zone is invalid",
        retryable: false,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries bounded read failures and validates scenario data", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ scenarios: [scenario] }));
    global.fetch = fetchMock;

    const pending = listScenarios();
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({ ok: true, data: [scenario] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://us2.make.com/api/v2/scenarios?teamId=42");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("caps a management read at three attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response("temporary", { status: 503 }));
    global.fetch = fetchMock;

    const pending = listScenarios();
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns a generic failure for malformed success data", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      Response.json({ scenario: { ...scenario, teamId: "wrong" }, private: "provider-secret" }),
    );

    const result = await getScenario(7);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_error",
        message: "Make management response was invalid",
        retryable: true,
        provider: "make",
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("uses the documented data field and returns a validated run receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ executionId: "execution-1", status: "1", output: { count: 2 } }),
    );
    global.fetch = fetchMock;

    const result = await runScenario(7, { account: "checking" });

    expect(result).toEqual({
      ok: true,
      data: { executionId: "execution-1", status: "1", output: { count: 2 } },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      responsive: true,
      data: { account: "checking" },
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("input");
  });

  it("never retries a scenario write and never exposes response content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("token=provider-secret", { status: 503 }),
    );
    global.fetch = fetchMock;

    const result = await runScenario(7);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "provider_error",
        message: "Make management request was rejected",
        status: 503,
      });
    }
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-serializable scenario input without calling Make", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const result = await runScenario(7, circular);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires Make to confirm the requested activation state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ scenario: { id: 7, isActive: true } }),
    );
    global.fetch = fetchMock;

    const result = await setScenarioActive(7, false);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "provider_error",
        message: "Make scenario state confirmation did not match",
        retryable: false,
        provider: "make",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://us2.make.com/api/v2/scenarios/7/stop");
  });

  it("returns the confirmed activation receipt", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      Response.json({ scenario: { id: 7, isActive: true, islinked: true } }),
    );

    const result = await setScenarioActive(7, true);

    expect(result).toEqual({ ok: true, data: { id: 7, isActive: true } });
  });

  it("normalizes network failures without leaking thrown messages", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("private-make-api-key leaked"));

    const result = await setScenarioActive(7, true);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "network",
        message: "Make management request failed",
        retryable: true,
        provider: "make",
      },
    });
    const captured = vi.mocked(Sentry.captureException).mock.calls.at(-1)?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("Make management request failed");
  });
});
