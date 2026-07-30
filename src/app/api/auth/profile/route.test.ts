import { createHash } from "node:crypto";
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

const OWNER_ID = "owner";
const OTHER_ID = "other-owner";
const OWNER_SUBJECT = `ps1_${createHash("sha256").update(OWNER_ID).digest("hex")}`;
const OTHER_SUBJECT = `ps1_${createHash("sha256").update(OTHER_ID).digest("hex")}`;
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

function validProfile(overrides: Record<string, string> = {}) {
  return {
    subject: OWNER_SUBJECT,
    name: "Name",
    role: "Role",
    bio: "Bio",
    photo: "https://cdn.test/avatar.jpg",
    ...overrides,
  };
}

function patchJson(body: unknown) {
  return patchText(JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: OWNER_ID,
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

  it("returns a stable exact non-PII subject with the bounded profile shape", async () => {
    mocks.result.data = null;
    mocks.from.mockReturnValue(query());

    const payload = await (await GET()).json();

    expect(payload).toEqual({
      subject: OWNER_SUBJECT,
      display_name: null,
      role_title: null,
      bio: null,
      avatar_url: null,
      email: null,
    });
    expect(payload.subject).toMatch(/^ps1_[a-f0-9]{64}$/);
    expect(payload.subject).not.toContain(OWNER_ID);
  });

  it.each([
    ["oversized", { display_name: "x".repeat(2_001) }],
    ["wrong-type", { role_title: 42 }],
  ])(
    "fails closed for an %s legacy row without returning a nulled profile or writing",
    async (_label, invalidField) => {
      const q = query();
      mocks.result.data = {
        display_name: "Existing Name",
        role_title: "Existing Role",
        bio: "Existing Bio",
        avatar_url: "https://cdn.test/existing.jpg",
        ...invalidField,
      };
      mocks.from.mockReturnValue(q);

      const response = await GET();

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "PROFILE_ACCOUNT_UNAVAILABLE",
      });
      expect(q.upsert).not.toHaveBeenCalled();
      expect(mocks.capture).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          operation: "read_profile_invalid",
          code: "PROFILE_ACCOUNT_UNAVAILABLE",
        }),
      );
    },
  );

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
    ["malformed JSON", "{"],
    [
      "extra key",
      JSON.stringify({ ...validProfile(), extra: "unexpected" }),
    ],
    [
      "duplicate key",
      `{"subject":"${OWNER_SUBJECT}","name":"one","\\u006eame":"two","role":"r","bio":"b","photo":"p"}`,
    ],
  ])("rejects an isolated %s body before auth", async (_label, body) => {
    const response = await PATCH(patchText(body));

    expect(response.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects a missing key, invalid subject, and oversized field before auth", async () => {
    const missing = await PATCH(
      patchJson({
        subject: OWNER_SUBJECT,
        name: "n",
        role: "r",
        bio: "b",
      }),
    );
    const invalidSubject = await PATCH(
      patchJson(validProfile({ subject: "owner" })),
    );
    const oversized = await PATCH(
      patchJson(validProfile({ name: "x".repeat(2_001) })),
    );

    expect(missing.status).toBe(400);
    expect(invalidSubject.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("accepts four maximum-length ASCII, CJK, emoji, and combining drafts", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    const boundary = {
      subject: OWNER_SUBJECT,
      name: "a".repeat(2_000),
      role: "界".repeat(2_000),
      bio: "😀".repeat(1_000),
      photo: "e\u0301".repeat(1_000),
    };

    const response = await PATCH(patchJson(boundary));

    expect(response.status).toBe(200);
    expect(q.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: OWNER_ID,
        display_name: boundary.name,
        role_title: boundary.role,
        bio: boundary.bio,
        avatar_url: boundary.photo,
      }),
    );
  });

  it("accepts the worst-case escaped size for all four valid fields", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    const escaped = "\u0001".repeat(2_000);

    const response = await PATCH(
      patchJson({
        subject: OWNER_SUBJECT,
        name: escaped,
        role: escaped,
        bio: escaped,
        photo: escaped,
      }),
    );

    expect(response.status).toBe(200);
    expect(q.upsert).toHaveBeenCalledTimes(1);
  });

  it("stops a chunked body above 64 KiB before auth", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify(validProfile({ name: "x".repeat(70_000) })),
    );
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 60_000));
        controller.enqueue(encoded.slice(60_000));
      },
      cancel,
    });
    const request = new Request("http://axis.test/api/auth/profile", {
      method: "PATCH",
      headers: VALID_HEADERS,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledTimes(1);
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
  it("upserts the authenticated owner and returns the subject-bound contract", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);

    const response = await PATCH(
      patchJson(
        validProfile({
          name: " Owner Name ",
          role: " Role ",
          bio: " Biography ",
          photo: " https://cdn.test/avatar.jpg ",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      subject: OWNER_SUBJECT,
    });
    expect(q.upsert).toHaveBeenCalledWith({
      id: OWNER_ID,
      display_name: "Owner Name",
      role_title: "Role",
      bio: "Biography",
      avatar_url: "https://cdn.test/avatar.jpg",
      updated_at: expect.any(String),
    });
  });

  it("returns a safe conflict and never writes across authenticated subjects", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);

    const response = await PATCH(
      patchJson(validProfile({ subject: OTHER_SUBJECT })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PROFILE_SUBJECT_CHANGED",
    });
    expect(q.upsert).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not write for an unauthenticated request", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const response = await PATCH(patchJson(validProfile()));

    expect(response.status).toBe(401);
    expect(q.upsert).not.toHaveBeenCalled();
  });
});
