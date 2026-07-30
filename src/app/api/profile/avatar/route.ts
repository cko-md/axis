import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { isProfileSubject } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const ROUTE = "/api/profile/avatar";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_AVATAR_REQUEST_BYTES =
  MAX_AVATAR_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MULTIPART_BOUNDARY_PATTERN =
  /^[0-9A-Za-z'()+_,./:=?-]{1,70}$/;

class AvatarRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code:
      | "INVALID_AVATAR_REQUEST"
      | "AVATAR_REQUEST_TOO_LARGE",
  ) {
    super(code);
  }
}

function unavailable(operation: string) {
  captureRouteError(new Error("Profile avatar operation failed"), {
    route: ROUTE,
    area: "profile",
    operation,
    status: 500,
    code: "PROFILE_AVATAR_UNAVAILABLE",
  });
  return NextResponse.json(
    { error: "PROFILE_AVATAR_UNAVAILABLE" },
    { status: 500 },
  );
}

function isMissingSession(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const value = error as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  return (
    value.status === 401 ||
    value.code === "refresh_token_not_found" ||
    value.code === "invalid_refresh_token" ||
    value.message === "Auth session missing!"
  );
}

function multipartBoundary(contentType: string | null) {
  if (!contentType) return null;
  const match = contentType.match(
    /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^";\s]+))$/,
  );
  const boundary = match?.[1] ?? match?.[2] ?? null;
  return boundary && MULTIPART_BOUNDARY_PATTERN.test(boundary)
    ? boundary
    : null;
}

async function boundedMultipartRequest(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new AvatarRequestError(400, "INVALID_AVATAR_REQUEST");
    }
    if (parsedLength > MAX_AVATAR_REQUEST_BYTES) {
      throw new AvatarRequestError(413, "AVATAR_REQUEST_TOO_LARGE");
    }
  }
  if (!request.body) {
    throw new AvatarRequestError(400, "INVALID_AVATAR_REQUEST");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > MAX_AVATAR_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw new AvatarRequestError(413, "AVATAR_REQUEST_TOO_LARGE");
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body,
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type");
  if (
    origin !== new URL(request.url).origin ||
    !multipartBoundary(contentType)
  ) {
    return NextResponse.json(
      { error: "INVALID_AVATAR_REQUEST" },
      { status: 400 },
    );
  }

  let boundedRequest: Request;
  try {
    boundedRequest = await boundedMultipartRequest(request);
  } catch (error) {
    if (error instanceof AvatarRequestError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: "INVALID_AVATAR_REQUEST" },
      { status: 400 },
    );
  }

  let form: FormData;
  try {
    form = await boundedRequest.formData();
  } catch {
    return NextResponse.json(
      { error: "INVALID_AVATAR_REQUEST" },
      { status: 400 },
    );
  }
  const keys = Array.from(form.keys());
  const fileValues = form.getAll("file");
  const subjectValues = form.getAll("subject");
  if (
    keys.length !== 2 ||
    fileValues.length !== 1 ||
    subjectValues.length !== 1
  ) {
    return NextResponse.json(
      { error: "INVALID_AVATAR_REQUEST" },
      { status: 400 },
    );
  }
  const file = fileValues[0];
  const expectedSubject = subjectValues[0];
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "INVALID_AVATAR_REQUEST" },
      { status: 400 },
    );
  }
  if (!isProfileSubject(expectedSubject)) {
    return NextResponse.json(
      { error: "INVALID_PROFILE_SUBJECT" },
      { status: 400 },
    );
  }

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
    let authResult: Awaited<
      ReturnType<typeof supabase.auth.getUser>
    >;
    try {
      authResult = await supabase.auth.getUser();
    } catch (error) {
      if (isMissingSession(error)) {
        return NextResponse.json(
          { error: "UNAUTHENTICATED" },
          { status: 401 },
        );
      }
      return unavailable("read_identity");
    }
    const {
      data: { user },
      error: authError,
    } = authResult;
    if (isMissingSession(authError) || (!authError && !user)) {
      return NextResponse.json(
        { error: "UNAUTHENTICATED" },
        { status: 401 },
      );
    }
    if (authError || !user) return unavailable("read_identity");

    if (expectedSubject !== profileSubjectForUserId(user.id)) {
      return NextResponse.json(
        { error: "PROFILE_SUBJECT_CHANGED" },
        { status: 409 },
      );
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return NextResponse.json(
        { error: "AVATAR_FILE_TOO_LARGE" },
        { status: 413 },
      );
    }
    const extension = ALLOWED_MIME_TO_EXT[file.type];
    if (!extension) {
      return NextResponse.json(
        { error: "UNSUPPORTED_AVATAR_TYPE" },
        { status: 415 },
      );
    }

    const path = `${user.id}/avatar.${extension}`;
    let uploadError: unknown;
    try {
      const result = await supabase.storage
        .from("avatars")
        .upload(path, file, {
          upsert: true,
          contentType: file.type,
        });
      uploadError = result.error;
    } catch {
      return unavailable("upload_avatar");
    }
    if (uploadError) return unavailable("upload_avatar");

    const {
      data: { publicUrl },
    } = supabase.storage.from("avatars").getPublicUrl(path);
    if (typeof publicUrl !== "string" || publicUrl.length > 2_000) {
      return unavailable("read_avatar_url");
    }
    const url = `${publicUrl}?t=${Date.now()}`;
    return NextResponse.json({ url, subject: expectedSubject });
  } catch {
    return unavailable("unexpected");
  }
}
