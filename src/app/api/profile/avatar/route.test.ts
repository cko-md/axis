import { createHash } from "node:crypto";
import { StorageClient } from "@supabase/storage-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getPublicEnv: vi.fn(),
  getUser: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.capture,
}));
vi.mock("@/lib/env", () => ({
  getPublicEnv: mocks.getPublicEnv,
}));

import { POST } from "./route";

const OWNER_ID = "owner";
const OWNER_SUBJECT = `ps1_${createHash("sha256").update(OWNER_ID).digest("hex")}`;
const OTHER_SUBJECT = `ps1_${createHash("sha256").update("other").digest("hex")}`;
const SUPABASE_ORIGIN = "https://project.supabase.co";
const AVATAR_PUBLIC_URL =
  `${SUPABASE_ORIGIN}/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`;

function request(
  subject: string,
  {
    file = new File(["image"], "avatar.jpg", { type: "image/jpeg" }),
    origin = "http://axis.test",
  }: {
    file?: File;
    origin?: string | null;
  } = {},
) {
  const form = new FormData();
  form.append("file", file);
  form.append("subject", subject);
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  return new Request("http://axis.test/api/profile/avatar", {
    method: "POST",
    headers,
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicEnv.mockReturnValue({
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  });
  mocks.getUser.mockResolvedValue({
    data: { user: { id: OWNER_ID } },
    error: null,
  });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.getPublicUrl.mockReturnValue({
    data: { publicUrl: AVATAR_PUBLIC_URL },
  });
  mocks.storageFrom.mockReturnValue({
    upload: mocks.upload,
    getPublicUrl: mocks.getPublicUrl,
  });
  mocks.createClient.mockResolvedValue({
    auth: { getUser: mocks.getUser },
    storage: { from: mocks.storageFrom },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/profile/avatar request boundary", () => {
  it("requires exact same-origin multipart with an explicit boundary", async () => {
    const missingOrigin = await POST(
      request(OWNER_SUBJECT, { origin: null }),
    );
    const foreignOrigin = await POST(
      request(OWNER_SUBJECT, { origin: "http://evil.test" }),
    );
    const wrongType = await POST(
      new Request("http://axis.test/api/profile/avatar", {
        method: "POST",
        headers: {
          Origin: "http://axis.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    const missingBoundary = await POST(
      new Request("http://axis.test/api/profile/avatar", {
        method: "POST",
        headers: {
          Origin: "http://axis.test",
          "Content-Type": "multipart/form-data",
        },
        body: "body",
      }),
    );

    for (const response of [
      missingOrigin,
      foreignOrigin,
      wrongType,
      missingBoundary,
    ]) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "INVALID_AVATAR_REQUEST",
      });
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects malformed multipart before auth", async () => {
    const response = await POST(
      new Request("http://axis.test/api/profile/avatar", {
        method: "POST",
        headers: {
          Origin: "http://axis.test",
          "Content-Type": "multipart/form-data; boundary=axis-boundary",
        },
        body: "--axis-boundary\r\nmalformed",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_AVATAR_REQUEST",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared content length before reading or auth", async () => {
    const response = await POST(
      new Request("http://axis.test/api/profile/avatar", {
        method: "POST",
        headers: {
          Origin: "http://axis.test",
          "Content-Type": "multipart/form-data; boundary=axis-boundary",
          "Content-Length": String(5 * 1024 * 1024 + 64 * 1024 + 1),
        },
        body: "unread",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "AVATAR_REQUEST_TOO_LARGE",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("cancels a chunked multipart body above the raw request cap before auth", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5_300_000));
        controller.enqueue(new Uint8Array(20_000));
      },
      cancel,
    });
    const oversized = new Request(
      "http://axis.test/api/profile/avatar",
      {
        method: "POST",
        headers: {
          Origin: "http://axis.test",
          "Content-Type": "multipart/form-data; boundary=axis-boundary",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = await POST(oversized);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "AVATAR_REQUEST_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe("/api/profile/avatar authentication and storage", () => {
  it("normalizes missing sessions to 401 without capture", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "invalid_refresh_token", status: 401 },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "UNAUTHENTICATED",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("normalizes thrown missing-session errors to 401 without capture", async () => {
    mocks.getUser.mockRejectedValue({
      message: "Auth session missing!",
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "UNAUTHENTICATED",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("maps genuine auth failures to a fixed safe 500", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: {
        status: 503,
        message: "private auth provider detail",
      },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "PROFILE_AVATAR_UNAVAILABLE",
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Profile avatar operation failed",
      }),
      expect.objectContaining({
        operation: "read_identity",
        code: "PROFILE_AVATAR_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private auth provider detail",
    );
  });

  it("checks the subject before any storage mutation", async () => {
    const response = await POST(request(OTHER_SUBJECT));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "PROFILE_SUBJECT_CHANGED",
    });
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it("rejects a malformed subject and unsupported file type", async () => {
    const malformedSubject = await POST(request("owner"));
    const unsupportedType = await POST(
      request(OWNER_SUBJECT, {
        file: new File(["text"], "avatar.txt", {
          type: "text/plain",
        }),
      }),
    );

    expect(malformedSubject.status).toBe(400);
    expect(unsupportedType.status).toBe(415);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("returns a subject-bound cache-busted public storage URL", async () => {
    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: expect.stringMatching(
        /^https:\/\/project\.supabase\.co\/storage\/v1\/object\/public\/avatars\/owner\/avatar\.jpg\?t=\d+$/,
      ),
      subject: OWNER_SUBJECT,
    });
    expect(mocks.upload).toHaveBeenCalledWith(
      `${OWNER_ID}/avatar.jpg`,
      expect.any(File),
      {
        upsert: true,
        contentType: "image/jpeg",
      },
    );
    expect(mocks.getPublicUrl.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.upload.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    "http://localhost:54321",
    "http://127.0.0.1:54321",
  ])("accepts the local Supabase loopback URL at %s", async (localOrigin) => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const localPublicUrl =
      `${localOrigin}/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`;
    mocks.getPublicEnv.mockReturnValue({
      NEXT_PUBLIC_SUPABASE_URL: localOrigin,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    });
    mocks.getPublicUrl.mockReturnValue({
      data: { publicUrl: localPublicUrl },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `${localPublicUrl}?t=1700000000000`,
      subject: OWNER_SUBJECT,
    });
  });

  it("accepts the configured Supabase custom base path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const configuredUrl = `${SUPABASE_ORIGIN}/gateway`;
    const publicUrl =
      `${configuredUrl}/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`;
    mocks.getPublicEnv.mockReturnValue({
      NEXT_PUBLIC_SUPABASE_URL: configuredUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    });
    mocks.getPublicUrl.mockReturnValue({
      data: { publicUrl },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `${publicUrl}?t=1700000000000`,
      subject: OWNER_SUBJECT,
    });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("preserves existing public URL query parameters when adding the cache nonce", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mocks.getPublicUrl.mockReturnValue({
      data: {
        publicUrl: `${AVATAR_PUBLIC_URL}?download=profile.jpg`,
      },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: `${AVATAR_PUBLIC_URL}?download=profile.jpg&t=1700000000000`,
      subject: OWNER_SUBJECT,
    });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("replaces and collapses duplicate cache nonces while preserving other query parameters", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    mocks.getPublicUrl.mockReturnValue({
      data: {
        publicUrl:
          `${AVATAR_PUBLIC_URL}?t=old&download=profile.jpg&t=stale`,
      },
    });

    const response = await POST(request(OWNER_SUBJECT));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      url: `${AVATAR_PUBLIC_URL}?t=1700000000000&download=profile.jpg`,
      subject: OWNER_SUBJECT,
    });
    expect(new URL(body.url).searchParams.getAll("t")).toEqual([
      "1700000000000",
    ]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("accepts the final URL at the client cap and rejects one byte over before upload", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const queryPrefix = `${AVATAR_PUBLIC_URL}?padding=`;
    const cacheNonce = "&t=1700000000000";
    const paddingLength =
      2_000 - queryPrefix.length - cacheNonce.length;
    mocks.getPublicUrl.mockReturnValueOnce({
      data: {
        publicUrl: `${queryPrefix}${"a".repeat(paddingLength)}`,
      },
    });

    const atCap = await POST(request(OWNER_SUBJECT));
    const atCapBody = await atCap.json();

    expect(atCap.status).toBe(200);
    expect(atCapBody.url).toHaveLength(2_000);
    expect(mocks.upload).toHaveBeenCalledTimes(1);

    mocks.getPublicUrl.mockReturnValueOnce({
      data: {
        publicUrl: `${queryPrefix}${"a".repeat(paddingLength + 1)}`,
      },
    });
    const overCap = await POST(request(OWNER_SUBJECT));

    expect(overCap.status).toBe(500);
    await expect(overCap.json()).resolves.toEqual({
      error: "PROFILE_AVATAR_UNAVAILABLE",
    });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "Profile avatar operation failed",
      }),
      expect.objectContaining({
        operation: "read_avatar_url",
        code: "PROFILE_AVATAR_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "padding=",
    );
  });

  it.each([
    {
      label: "malformed",
      publicUrl: "not a URL",
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "unsafe protocol",
      publicUrl:
        `javascript:alert(1)/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "foreign origin",
      publicUrl:
        `https://attacker.test/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "credential-bearing URL",
      publicUrl:
        `https://user:password@project.supabase.co/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "fragment",
      publicUrl: `${AVATAR_PUBLIC_URL}#private-fragment`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "encoded owner",
      publicUrl:
        `${SUPABASE_ORIGIN}/storage/v1/object/public/avatars/%6Fwner/avatar.jpg`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "foreign owner",
      publicUrl:
        `${SUPABASE_ORIGIN}/storage/v1/object/public/avatars/other/avatar.jpg`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "wrong storage path",
      publicUrl:
        `${SUPABASE_ORIGIN}/storage/v1/object/sign/avatars/${OWNER_ID}/avatar.jpg`,
      configuredUrl: SUPABASE_ORIGIN,
    },
    {
      label: "configured base-path mismatch",
      publicUrl: AVATAR_PUBLIC_URL,
      configuredUrl: `${SUPABASE_ORIGIN}/gateway`,
    },
    {
      label: "non-loopback HTTP",
      publicUrl:
        `http://project.supabase.co/storage/v1/object/public/avatars/${OWNER_ID}/avatar.jpg`,
      configuredUrl: "http://project.supabase.co",
    },
  ])(
    "rejects a $label safely before upload",
    async ({ publicUrl, configuredUrl }) => {
      mocks.getPublicEnv.mockReturnValue({
        NEXT_PUBLIC_SUPABASE_URL: configuredUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
      });
      mocks.getPublicUrl.mockReturnValue({
        data: { publicUrl },
      });

      const response = await POST(request(OWNER_SUBJECT));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "PROFILE_AVATAR_UNAVAILABLE",
      });
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Profile avatar operation failed",
        }),
        expect.objectContaining({
          operation: "read_avatar_url",
          code: "PROFILE_AVATAR_UNAVAILABLE",
        }),
      );
      expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
        publicUrl,
      );
    },
  );

  it("fails closed before upload for storage-js 2.108.1 percent-encoded IPv6 brackets", async () => {
    const configuredUrl = "http://[::1]:54321";
    const storage = new StorageClient(`${configuredUrl}/storage/v1`);
    const {
      data: { publicUrl },
    } = storage
      .from("avatars")
      .getPublicUrl(`${OWNER_ID}/avatar.jpg`);
    expect(publicUrl).toBe(
      "http://%5B::1%5D:54321/storage/v1/object/public/avatars/owner/avatar.jpg",
    );
    expect(() => new URL(publicUrl)).toThrow(TypeError);
    mocks.getPublicEnv.mockReturnValue({
      NEXT_PUBLIC_SUPABASE_URL: configuredUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
    });
    mocks.getPublicUrl.mockReturnValue({
      data: { publicUrl },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "PROFILE_AVATAR_UNAVAILABLE",
    });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Profile avatar operation failed",
      }),
      expect.objectContaining({
        operation: "read_avatar_url",
        code: "PROFILE_AVATAR_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      publicUrl,
    );
  });

  it("maps storage failures to fixed metadata without raw provider leakage", async () => {
    mocks.upload.mockResolvedValue({
      error: { message: "private storage bucket detail" },
    });

    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "PROFILE_AVATAR_UNAVAILABLE",
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Profile avatar operation failed",
      }),
      expect.objectContaining({
        operation: "upload_avatar",
        code: "PROFILE_AVATAR_UNAVAILABLE",
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private storage bucket detail",
    );
  });
});
