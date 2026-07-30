import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  getUser: vi.fn(),
  from: vi.fn(),
  result: {
    data: null as unknown,
    error: null as unknown,
  },
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

import { GET, PATCH } from "./route";

const VALID_HEADERS = {
  "Content-Type": "application/json",
  Origin: "http://axis.test",
};

function query() {
  const value: Record<string, ReturnType<typeof vi.fn>> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => mocks.result);
  value.upsert = vi.fn(async () => ({ error: mocks.result.error }));
  return value;
}

function patchText(
  body: string,
  headers: Record<string, string> = VALID_HEADERS,
) {
  return new NextRequest("http://axis.test/api/auth/profile", {
    method: "PATCH",
    headers,
    body,
  });
}

function patchJson(body: unknown) {
  return patchText(JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: "owner",
        email: null,
      },
    },
    error: null,
  });
  mocks.result = {
    data: {
      display_name: null,
      role_title: null,
      bio: null,
      avatar_url: null,
    },
    error: null,
  };
});

describe("/api/auth/profile GET", () => {
  it("returns an explicit signed-out response", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    expect((await GET()).status).toBe(401);
  });

  it("normalizes missing refresh sessions but captures genuine auth failures", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "invalid_refresh_token", status: 401 },
    });
    expect((await GET()).status).toBe(401);
    expect(mocks.capture).not.toHaveBeenCalled();

    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "auth service unavailable", status: 503 },
    });
    expect((await GET()).status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("captures thrown identity reads without returning raw errors", async () => {
    mocks.getUser.mockRejectedValue(
      new Error("private auth transport detail"),
    );

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "PROFILE_ACCOUNT_UNAVAILABLE",
    });
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private auth transport detail",
    );
  });

  it("returns only bounded strings and supports accounts without email", async () => {
    mocks.result.data = {
      display_name: "x".repeat(2_001),
      role_title: 42,
      bio: "Biography",
      avatar_url: null,
    };
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "owner",
          email: "e".repeat(321),
        },
      },
      error: null,
    });
    mocks.from.mockReturnValue(query());

    expect(await (await GET()).json()).toEqual({
      display_name: null,
      role_title: null,
      bio: "Biography",
      avatar_url: null,
      email: null,
    });
  });

  it("maps database failures to fixed safe observability metadata", async () => {
    mocks.result = {
      data: null,
      error: { message: "private database detail" },
    };
    mocks.from.mockReturnValue(query());

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "PROFILE_ACCOUNT_UNAVAILABLE",
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "/api/auth/profile",
        code: "PROFILE_ACCOUNT_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private database detail",
    );
  });
});

describe("/api/auth/profile PATCH validation", () => {
  it.each([
    ["null", "null"],
    ["array", "[]"],
    [
      "extra key",
      JSON.stringify({
        name: "n",
        role: "r",
        bio: "b",
        photo: "p",
        extra: true,
      }),
    ],
    ["malformed JSON", "{"],
  ])("rejects an isolated %s body before auth", async (_label, body) => {
    const response = await PATCH(patchText(body));

    expect(response.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects a missing key and an oversized field before auth", async () => {
    const missing = await PATCH(
      patchJson({ name: "n", role: "r", bio: "b" }),
    );
    const oversized = await PATCH(
      patchJson({
        name: "x".repeat(2_001),
        role: "r",
        bio: "b",
        photo: "p",
      }),
    );

    expect(missing.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("stops a chunked valid UTF-8 body at the byte limit before auth", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        name: "é".repeat(2_000),
        role: "é".repeat(2_000),
        bio: "é".repeat(2_000),
        photo: "é".repeat(2_000),
      }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 7_000));
        controller.enqueue(encoded.slice(7_000));
        controller.close();
      },
    });
    const request = new Request("http://axis.test/api/auth/profile", {
      method: "PATCH",
      headers: VALID_HEADERS,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires exact same-origin JSON before auth", async () => {
    const missingContentType = await PATCH(
      patchText("{}", { Origin: "http://axis.test" }),
    );
    const foreignOrigin = await PATCH(
      patchText("{}", {
        "Content-Type": "application/json",
        Origin: "http://evil.test",
      }),
    );

    expect(missingContentType.status).toBe(400);
    expect(foreignOrigin.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});

describe("/api/auth/profile PATCH persistence", () => {
  it("upserts the authenticated owner and returns the exact success contract", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);

    const response = await PATCH(
      patchJson({
        name: " Owner Name ",
        role: " Role ",
        bio: " Biography ",
        photo: " https://cdn.test/avatar.jpg ",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.from).toHaveBeenCalledWith("profiles");
    expect(q.upsert).toHaveBeenCalledWith({
      id: "owner",
      display_name: "Owner Name",
      role_title: "Role",
      bio: "Biography",
      avatar_url: "https://cdn.test/avatar.jpg",
      updated_at: expect.any(String),
    });
  });

  it("does not write for an unauthenticated request", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const response = await PATCH(
      patchJson({ name: "", role: "", bio: "", photo: "" }),
    );

    expect(response.status).toBe(401);
    expect(q.upsert).not.toHaveBeenCalled();
  });
});
