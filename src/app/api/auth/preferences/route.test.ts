import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abortSignals: [] as AbortSignal[],
  capture: vi.fn(),
  from: vi.fn(),
  getUser: vi.fn(),
  result: { data: null as unknown, error: null as unknown },
  upsert: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.capture,
}));

import { GET, PUT } from "./route";

const OWNER_ID = "owner";
const OTHER_ID = "other-owner";
const OWNER_SUBJECT = `ps1_${createHash("sha256").update(OWNER_ID).digest("hex")}`;
const ROUTE_URL = "http://axis.test/api/auth/preferences";

function query() {
  let mutation = false;
  const value: Record<string, ReturnType<typeof vi.fn>> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => mocks.result);
  value.upsert = vi.fn((...args: unknown[]) => {
    mutation = true;
    mocks.upsert(...args);
    return value;
  });
  value.abortSignal = vi.fn((signal: AbortSignal) => {
    mocks.abortSignals.push(signal);
    return mutation ? Promise.resolve({ error: mocks.result.error }) : value;
  });
  return value;
}

function getRequest(signal?: AbortSignal) {
  return new Request(ROUTE_URL, { signal });
}

function putText(body: string, headers: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: "http://axis.test",
}) {
  return new Request(ROUTE_URL, {
    method: "PUT",
    headers,
    body,
  });
}

function putJson(body: unknown) {
  return putText(JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.abortSignals = [];
  mocks.result = { data: null, error: null };
  mocks.getUser.mockResolvedValue({
    data: { user: { id: OWNER_ID } },
    error: null,
  });
  mocks.from.mockImplementation(() => query());
});

describe("/api/auth/preferences GET", () => {
  it("returns no-store signed-out responses without querying or capturing", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const request = getRequest();
    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("normalizes missing refresh sessions and safely captures genuine auth failures", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "invalid_refresh_token", status: 401 },
    });
    expect((await GET(getRequest())).status).toBe(401);
    expect(mocks.capture).not.toHaveBeenCalled();

    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "private auth detail", status: 503 },
    });
    const request = getRequest();
    const response = await GET(request);
    expect(response.status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "read",
        code: "PROFILE_LOAD_FAILED",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private auth detail",
    );
  });

  it("tags preference route failures as direct Supabase transport", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "backend_unavailable", status: 503 },
    });

    expect((await GET(getRequest())).status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ transport: "direct" }),
    );
  });

  it("normalizes thrown missing-session failures without querying or capturing", async () => {
    mocks.getUser.mockRejectedValue({ message: "Auth session missing!" });

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("returns only the opaque subject and owner-scoped envelope", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    mocks.result.data = {
      interface_settings: { theme: "dim", preserved: { revision: 3 } },
    };

    const request = getRequest();
    const response = await GET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({
      subject: OWNER_SUBJECT,
      envelope: { theme: "dim", preserved: { revision: 3 } },
    });
    expect(JSON.stringify(payload)).not.toContain(OWNER_ID);
    expect(q.eq).toHaveBeenCalledWith("user_id", OWNER_ID);
    expect(mocks.abortSignals).toEqual([request.signal]);
  });

  it("fails closed on invalid stored envelopes and database errors", async () => {
    mocks.result = {
      data: { interface_settings: ["not-an-envelope"] },
      error: null,
    };
    let response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "PREFERENCES_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    mocks.capture.mockClear();
    mocks.result = {
      data: null,
      error: { message: "private database detail" },
    };
    response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private database detail",
    );
  });

  it("passes the request signal to the RLS query and does not capture cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await GET(getRequest(controller.signal));

    expect(response.status).toBe(499);
    expect(mocks.abortSignals[0]?.aborted).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe("/api/auth/preferences PUT", () => {
  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["malformed", "{"],
    ["extra key", JSON.stringify({ subject: OWNER_SUBJECT, envelope: {}, extra: true })],
    ["invalid subject", JSON.stringify({ subject: OWNER_ID, envelope: {} })],
    ["array envelope", JSON.stringify({ subject: OWNER_SUBJECT, envelope: [] })],
    ["invalid theme", JSON.stringify({ subject: OWNER_SUBJECT, envelope: { theme: "red" } })],
    ["unknown settings key", JSON.stringify({ subject: OWNER_SUBJECT, envelope: { settings: { secret: true } } })],
    ["dangerous non-JSON value", `{"subject":"${OWNER_SUBJECT}","envelope":{"__proto__":{"polluted":true}}}`],
    ["duplicate root key", `{"subject":"${OWNER_SUBJECT}","subject":"${OWNER_SUBJECT}","envelope":{}}`],
    ["escape-equivalent root key", `{"subject":"${OWNER_SUBJECT}","\\u0073ubject":"${OWNER_SUBJECT}","envelope":{}}`],
    ["duplicate nested key", `{"subject":"${OWNER_SUBJECT}","envelope":{"settings":{"accent":"gold","accent":"sage"}}}`],
    ["escape-equivalent nested key", `{"subject":"${OWNER_SUBJECT}","envelope":{"settings":{"accent":"gold","\\u0061ccent":"sage"}}}`],
    ["deep array-object duplicate key", `{"subject":"${OWNER_SUBJECT}","envelope":{"metadata":[{"revision":1,"\\u0072evision":2}]}}`],
  ])("rejects %s input before authentication", async (_label, body) => {
    const response = await PUT(putText(body));

    expect(response.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires exact same-origin JSON and bounds streamed input", async () => {
    expect((await PUT(putText("{}", { Origin: "http://axis.test" }))).status)
      .toBe(400);
    expect((await PUT(putText("{}", {
      "Content-Type": "application/json",
      Origin: "http://evil.test",
    }))).status).toBe(400);

    const encoded = new TextEncoder().encode(JSON.stringify({
      subject: OWNER_SUBJECT,
      envelope: { value: "x".repeat(140_000) },
    }));
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 120_000));
        controller.enqueue(encoded.slice(120_000));
      },
      cancel,
    });
    const request = new Request(ROUTE_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://axis.test",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect((await PUT(request)).status).toBe(400);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("never writes when unauthenticated or when the opaque subject changed", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await PUT(putJson({ subject: OWNER_SUBJECT, envelope: {} }))).status)
      .toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();

    mocks.getUser.mockResolvedValue({
      data: { user: { id: OTHER_ID } },
      error: null,
    });
    const response = await PUT(putJson({
      subject: OWNER_SUBJECT,
      envelope: { theme: "light" },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PROFILE_SUBJECT_CHANGED" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("normalizes thrown missing-session failures without writing or capturing", async () => {
    mocks.getUser.mockRejectedValue({ code: "invalid_refresh_token" });

    const response = await PUT(putJson({
      subject: OWNER_SUBJECT,
      envelope: { theme: "light" },
    }));

    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("upserts only the server-derived owner and returns the exact subject", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    const envelope = { theme: "light", preserved: { revision: 4 } };

    const response = await PUT(putJson({ subject: OWNER_SUBJECT, envelope }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, subject: OWNER_SUBJECT });
    expect(mocks.upsert).toHaveBeenCalledWith(
      {
        user_id: OWNER_ID,
        interface_settings: envelope,
        updated_at: expect.any(String),
      },
      { onConflict: "user_id" },
    );
    expect(mocks.abortSignals).toHaveLength(1);
  });

  it("projects write failures safely and does not capture request cancellation", async () => {
    mocks.result.error = { message: "private write detail" };
    let response = await PUT(putJson({ subject: OWNER_SUBJECT, envelope: {} }));
    expect(response.status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "save", code: "PROFILE_SAVE_FAILED" }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private write detail",
    );

    mocks.capture.mockClear();
    mocks.result.error = null;
    const controller = new AbortController();
    const request = putJson({ subject: OWNER_SUBJECT, envelope: {} });
    const abortedRequest = new Request(request, { signal: controller.signal });
    controller.abort();
    response = await PUT(abortedRequest);
    expect(response.status).toBe(499);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
