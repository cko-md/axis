import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const dependencies = vi.hoisted(() => {
  class StoreError extends Error {
    constructor(
      public readonly reason: "conflict" | "unavailable" = "unavailable",
    ) {
      super("PLAID_CONNECTION_STORE_UNAVAILABLE");
      this.name = "PlaidConnectionStoreUnavailableError";
    }
  }
  return {
    StoreError,
    admin: vi.fn(),
    admission: vi.fn(),
    capture: vi.fn(),
    client: vi.fn(),
    save: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => dependencies.client(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => dependencies.admin(),
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    financial: {
      name: "financial",
      limit: 20,
      window: "1 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => dependencies.admission(...args),
}));
vi.mock("@/lib/fund/plaidTokens", () => ({
  PlaidConnectionStoreUnavailableError: dependencies.StoreError,
  savePlaidConnection: (...args: unknown[]) => dependencies.save(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => dependencies.capture(...args),
}));
vi.mock("../_lib", () => ({
  getPlaidCreds: () => ({
    clientId: "client-id",
    secret: "secret-value",
    env: "sandbox",
  }),
  plaidHost: () => "https://sandbox.plaid.test",
}));

function request(
  value: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest("https://axis.test/api/plaid/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function exchangeResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({
    access_token: "new-access-token",
    item_id: "new-item-id",
    request_id: "exchange-request-id",
    ...overrides,
  });
}

function cleanupResponse(value: unknown = { request_id: "remove-request-id" }) {
  return jsonResponse(value);
}

function adminClient(
  existing: Array<{ id: string }> = [],
  error: unknown = null,
  reconcile: {
    updateError?: unknown;
    rows?: Array<Record<string, unknown>>;
    verifyError?: unknown;
  } = {},
) {
  function queryResult(data: unknown, queryError: unknown) {
    const query = {
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      limit: vi.fn(() => query),
      abortSignal: vi.fn(async () => ({ data, error: queryError })),
    };
    return query;
  }
  const preflight = queryResult(existing, error);
  const verify = queryResult(reconcile.rows ?? [], reconcile.verifyError ?? null);
  const updateQuery = {
    eq: vi.fn(() => updateQuery),
    abortSignal: vi.fn(async () => ({
      data: null,
      error: reconcile.updateError ?? null,
    })),
  };
  const select = vi.fn((projection: string) =>
    projection === "id" ? preflight : verify);
  const update = vi.fn(() => updateQuery);
  const from = vi.fn(() => ({ select, update }));
  return {
    from,
    query: preflight,
    limit: preflight.limit,
    select,
    update,
    updateQuery,
    verify,
  };
}

describe("POST /api/plaid/exchange credential transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.client.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        })),
      },
    });
    dependencies.admin.mockReturnValue(adminClient());
    dependencies.admission.mockResolvedValue({ kind: "allowed" });
    dependencies.save.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["client creation throws", null],
    ["throws", () => Promise.reject(new Error("socket detail"))],
    [
      "returns an error",
      () => Promise.resolve({
        data: { user: null },
        error: { message: "private auth detail" },
      }),
    ],
  ])("returns an observable 503 when auth %s", async (_case, getUser) => {
    if (getUser === null) {
      dependencies.client.mockImplementation(() => {
        throw new Error("client configuration detail");
      });
    } else {
      dependencies.client.mockReturnValue({ auth: { getUser: vi.fn(getUser) } });
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      public_token: "public-token",
      institution: null,
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "AUTH_BACKEND_UNAVAILABLE",
    });
    expect(dependencies.capture).toHaveBeenCalled();
    expect(dependencies.admission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 only for a successful absent-user result", async () => {
    dependencies.client.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: null,
        })),
      },
    });

    const response = await POST(request({
      public_token: "public-token",
      institution: null,
    }));

    expect(response.status).toBe(401);
    expect(dependencies.capture).not.toHaveBeenCalled();
  });

  it("runs one protected admission before reading or dispatching", async () => {
    dependencies.admission.mockResolvedValue({
      kind: "limited",
      retryAfterSeconds: 17,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("{"));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(dependencies.admission).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains a thrown admission backend failure", async () => {
    dependencies.admission.mockRejectedValue(new Error("redis detail"));

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "ADMISSION_UNAVAILABLE",
    });
    expect(dependencies.admission).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown key", { public_token: "public-token", institution: null, user_id: "other" }],
    ["missing token", { institution: null }],
    ["empty token", { public_token: " ", institution: null }],
    ["wrong institution type", { public_token: "public-token", institution: 42 }],
    ["empty institution", { public_token: "public-token", institution: " " }],
  ])("rejects strict input with %s before provider dispatch", async (
    _case,
    body,
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dependencies.admin).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body before provider dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(
      { public_token: "public-token" },
      { "content-length": "9000" },
    ));

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks an existing linked Item before exchange with an owner-scoped cap", async () => {
    const admin = adminClient([{ id: "connection-1" }]);
    dependencies.admin.mockReturnValue(admin);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PLAID_ALREADY_LINKED" });
    expect(admin.query.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(admin.query.eq).toHaveBeenNthCalledWith(2, "provider", "plaid");
    expect(admin.query.neq).toHaveBeenCalledWith("status", "revoked");
    expect(admin.limit).toHaveBeenCalledWith(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["returns null", () => null],
    ["throws", () => { throw new Error("configuration detail"); }],
  ])("returns an observable 503 when the admin store %s", async (
    _case,
    admin,
  ) => {
    dependencies.admin.mockImplementation(admin);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "CONNECTION_STORE_UNAVAILABLE",
    });
    expect(dependencies.capture).toHaveBeenCalled();
  });

  it("contains a thrown admin preflight query", async () => {
    dependencies.admin.mockReturnValue({
      from: vi.fn(() => {
        throw new Error("private database detail");
      }),
    });

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "CONNECTION_STORE_UNAVAILABLE",
    });
  });

  it("performs one bounded exchange and persists with the authenticated owner id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(exchangeResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      public_token: "public-token",
      institution: " Owner Bank ",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox.plaid.test/item/public_token/exchange",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          "Plaid-Version": "2020-09-14",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(dependencies.save).toHaveBeenCalledWith(
      "user-1",
      "new-access-token",
      "new-item-id",
      "Owner Bank",
    );
  });

  it("never reflects an upstream error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("private provider detail", { status: 400 }),
    ));

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("private");
    expect(dependencies.save).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", new Response("{", { status: 200 })],
    [
      "oversized JSON",
      new Response(JSON.stringify({
        access_token: "x".repeat(9_000),
        item_id: "new-item-id",
        request_id: "exchange-request-id",
      })),
    ],
  ])("escalates a 2xx %s response that cannot yield a cleanup token", async (
    _case,
    providerResponse,
  ) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse);
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "PLAID_CLEANUP_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("compensates a malformed successful exchange that already issued a token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(exchangeResponse({ item_id: "" }))
      .mockResolvedValueOnce(cleanupResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cleanupBody = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body),
    );
    expect(cleanupBody).toMatchObject({
      access_token: "new-access-token",
    });
    expect(dependencies.save).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["wrong type", 42],
    ["empty", ""],
    ["over cap", "t".repeat(4_097)],
  ])("escalates a 2xx exchange with a %s removal credential", async (
    _case,
    accessToken,
  ) => {
    const body: Record<string, unknown> = {
      item_id: "new-item-id",
      request_id: "exchange-request-id",
    };
    if (accessToken !== undefined) body.access_token = accessToken;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "PLAID_CLEANUP_REQUIRED",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dependencies.save).not.toHaveBeenCalled();
  });

  it("compensates an encryption/store failure and returns retryable 503", async () => {
    dependencies.save.mockResolvedValue(false);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(cleanupResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "CONNECTION_STORE_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts additive exchange and removal response fields", async () => {
    dependencies.save.mockResolvedValue(false);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(exchangeResponse({ future_field: "ignored" }))
      .mockResolvedValueOnce(cleanupResponse({
        request_id: "remove-request-id",
        future_field: "ignored",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "CONNECTION_STORE_UNAVAILABLE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({
        "Plaid-Version": "2020-09-14",
      }),
    }));
  });

  it("compensates a unique race and returns conflict", async () => {
    dependencies.save.mockRejectedValue(
      new dependencies.StoreError("conflict"),
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(cleanupResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PLAID_ALREADY_LINKED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks an error-state Item that can still retain active authorization", async () => {
    const admin = adminClient([{ id: "error-connection" }]);
    dependencies.admin.mockReturnValue(admin);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(409);
    expect(admin.query.neq).toHaveBeenCalledWith("status", "revoked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["local update fails", { updateError: { code: "DB_DOWN" } }],
    ["local verification fails", { verifyError: { code: "DB_DOWN" } }],
    [
      "local row remains active",
      {
        rows: [{
          status: "linked",
          authority: "provider_verified",
          verified_at: "2026-07-23T23:00:00.000Z",
          access_token_enc: "ciphertext",
          refresh_token_enc: null,
        }],
      },
    ],
  ])("escalates an ambiguous save when %s", async (_case, reconcile) => {
    dependencies.admin.mockReturnValue(adminClient([], null, reconcile));
    dependencies.save.mockRejectedValue(
      new dependencies.StoreError("unavailable"),
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(cleanupResponse());
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "PLAID_CLEANUP_REQUIRED",
    });
  });

  it.each([
    ["HTTP failure", new Response("failed", { status: 500 })],
    ["legacy removed flag without request id", cleanupResponse({ removed: true })],
    ["oversized response", new Response(JSON.stringify({
      request_id: "x".repeat(9_000),
    }))],
  ])("escalates when compensating removal has %s", async (
    _case,
    cleanup,
  ) => {
    dependencies.save.mockResolvedValue(false);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(cleanup);
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ public_token: "public-token" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "PLAID_CLEANUP_REQUIRED",
    });
    expect(dependencies.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "PLAID_CLEANUP_REQUIRED" }),
    );
  });
});
