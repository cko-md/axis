import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const getUser = vi.fn();
const listMailAccounts = vi.fn();
const listInbox = vi.fn();
const persistMailSyncSuccess = vi.fn();
const persistMailSyncFailure = vi.fn();
const recordProviderFailure = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/mail/tokens", () => ({
  listMailAccounts: (...args: unknown[]) => listMailAccounts(...args),
}));
vi.mock("@/lib/mail/adapters", () => ({
  adapterForAccount: () => ({ listInbox }),
  mailErrorStatus: () => 502,
  toMailContext: (userId: string, account: unknown) => ({ userId, account }),
}));
vi.mock("@/lib/mail/cache", () => ({
  persistMailSyncSuccess: (...args: unknown[]) => persistMailSyncSuccess(...args),
  persistMailSyncFailure: (...args: unknown[]) => persistMailSyncFailure(...args),
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  ProviderTimeoutError: class ProviderTimeoutError extends Error {},
  logRouteTiming: vi.fn(),
  recordProviderFailure: (...args: unknown[]) => recordProviderFailure(...args),
  timedProviderOperation: (_timing: unknown, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const account = {
  provider: "gmail" as const,
  mailEmail: "owner@example.com",
  via: "composio" as const,
  connectedAccountId: "ca_1",
};
const message = {
  id: "message_1",
  threadId: "thread_1",
  from: "sender@example.com",
  subject: "Update",
  date: "2026-07-15T20:00:00.000Z",
  snippet: "Preview",
  isUnread: true,
  provider: "gmail" as const,
  accountEmail: "owner@example.com",
  connectedAccountId: "ca_1",
};

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/mail/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mail/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "user_1" } } });
    listMailAccounts.mockResolvedValue([account]);
    persistMailSyncSuccess.mockResolvedValue(undefined);
    persistMailSyncFailure.mockResolvedValue(undefined);
  });

  it("rejects an unauthenticated refresh before provider access", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const response = await POST(request({}));

    expect(response.status).toBe(401);
    expect(listInbox).not.toHaveBeenCalled();
  });

  it("writes a successful first page to cache and returns the live rows", async () => {
    listInbox.mockResolvedValue({
      ok: true,
      data: { messages: [message], nextPageToken: "next_1", hasMore: true },
    });

    const response = await POST(request({}));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ messages: [message], fromCache: false, hasMore: true, nextPageToken: "next_1" });
    expect(persistMailSyncSuccess).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      account,
      [message],
      expect.objectContaining({ reconcileFirstPage: true }),
    );
    expect(persistMailSyncFailure).not.toHaveBeenCalled();
  });

  it("appends a requested page without reconciling the first-page window", async () => {
    listInbox.mockResolvedValue({ ok: true, data: { messages: [message], hasMore: false } });

    await POST(request({ account: account.mailEmail, provider: "gmail", pageToken: "page_2" }));

    expect(listInbox).toHaveBeenCalledWith(expect.anything(), { pageToken: "page_2", skip: 0 });
    expect(persistMailSyncSuccess).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      account,
      [message],
      expect.objectContaining({ reconcileFirstPage: false }),
    );
  });

  it("records a normalized failure without replacing the cache", async () => {
    listInbox.mockResolvedValue({
      ok: false,
      error: { code: "rate_limited", message: "Try later", retryable: true, status: 429 },
    });

    const response = await POST(request({}));
    const body = await response.json();

    expect(body.partial).toBe(true);
    expect(body.messages).toEqual([]);
    expect(persistMailSyncFailure).toHaveBeenCalledWith(
      expect.anything(), "user_1", account, "rate_limited", expect.any(String),
    );
    expect(persistMailSyncSuccess).not.toHaveBeenCalled();
    expect(recordProviderFailure).toHaveBeenCalledOnce();
  });

  it("does not allow a caller to sync an unowned mailbox", async () => {
    const response = await POST(request({ account: "other@example.com", provider: "gmail" }));

    expect(response.status).toBe(404);
    expect(listInbox).not.toHaveBeenCalled();
  });
});
