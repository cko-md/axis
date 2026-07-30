import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
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

import { POST } from "./route";

const OWNER_ID = "owner";
const OWNER_SUBJECT = `ps1_${createHash("sha256").update(OWNER_ID).digest("hex")}`;
const OTHER_SUBJECT = `ps1_${createHash("sha256").update("other").digest("hex")}`;

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
  mocks.getUser.mockResolvedValue({
    data: { user: { id: OWNER_ID } },
    error: null,
  });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.getPublicUrl.mockReturnValue({
    data: { publicUrl: "https://cdn.test/avatar.jpg" },
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

  it("returns a subject-bound URL after a successful upload", async () => {
    const response = await POST(request(OWNER_SUBJECT));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: expect.stringMatching(
        /^https:\/\/cdn\.test\/avatar\.jpg\?t=\d+$/,
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
