import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
  getPublicUrl: vi.fn(),
  redact: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    storage: { from: mocks.storageFrom },
  }),
}));
vi.mock("@/lib/observability/redactRouteError", () => ({
  redactRouteError: mocks.redact,
}));

import { POST } from "./route";

const OWNER_ID = "owner";
const OWNER_SUBJECT = `ps1_${createHash("sha256").update(OWNER_ID).digest("hex")}`;
const OTHER_SUBJECT = `ps1_${createHash("sha256").update("other").digest("hex")}`;

function request(subject: string) {
  const form = new FormData();
  form.append(
    "file",
    new File(["image"], "avatar.jpg", { type: "image/jpeg" }),
  );
  form.append("subject", subject);
  return new Request("http://axis.test/api/profile/avatar", {
    method: "POST",
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
});

describe("/api/profile/avatar", () => {
  it("binds the upload and response to the authenticated subject", async () => {
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

  it("rejects an account mismatch before storage mutation", async () => {
    const response = await POST(request(OTHER_SUBJECT));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "PROFILE_SUBJECT_CHANGED",
    });
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("rejects a malformed subject before storage mutation", async () => {
    const response = await POST(request("owner"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "INVALID_PROFILE_SUBJECT",
    });
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });
});
