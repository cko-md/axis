import { NextResponse } from "next/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";
import { isProfileSubject } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const ROUTE = "/api/auth/profile";

type ProfilePayload = {
  subject: string;
  display_name: string | null;
  role_title: string | null;
  bio: string | null;
  avatar_url: string | null;
  email: string | null;
};

const PROFILE_KEYS = ["subject", "name", "role", "bio", "photo"] as const;
const STORED_PROFILE_KEYS = [
  "display_name",
  "role_title",
  "bio",
  "avatar_url",
] as const;
const MAX_PROFILE_FIELD_LENGTH = 2_000;
const MAX_PROFILE_EMAIL_LENGTH = 320;
const MAX_PROFILE_BODY_BYTES = 64 * 1_024;

function unavailable(operation: string) {
  captureRouteError(new Error("Profile account operation failed"), {
    route: ROUTE,
    area: "auth",
    operation,
    status: 500,
    code: "PROFILE_ACCOUNT_UNAVAILABLE",
  });
  return NextResponse.json(
    { error: "PROFILE_ACCOUNT_UNAVAILABLE" },
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

function identityResponse(user: unknown, error: unknown, operation: string) {
  if (isMissingSession(error)) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (error) return unavailable(operation);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return null;
}

function isBoundedNullableString(value: unknown, maxLength: number) {
  return (
    value === null ||
    (typeof value === "string" && value.length <= maxLength)
  );
}

function isStoredProfile(
  value: unknown,
): value is Record<(typeof STORED_PROFILE_KEYS)[number], string | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return STORED_PROFILE_KEYS.every((key) =>
    isBoundedNullableString(record[key], MAX_PROFILE_FIELD_LENGTH),
  );
}

function skipJsonWhitespace(text: string, start: number) {
  let index = start;
  while (
    text[index] === " " ||
    text[index] === "\t" ||
    text[index] === "\r" ||
    text[index] === "\n"
  ) {
    index += 1;
  }
  return index;
}

function readJsonString(text: string, start: number) {
  if (text[start] !== '"') throw new Error("Expected JSON string");
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const raw = text.slice(start, index + 1);
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "string") throw new Error("Invalid JSON string");
      return { value, next: index + 1 };
    }
    if (character === "\\") {
      const escape = text[index + 1];
      if (escape === undefined) throw new Error("Invalid JSON escape");
      index += escape === "u" ? 6 : 2;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      throw new Error("Invalid JSON control character");
    }
    index += 1;
  }
  throw new Error("Unterminated JSON string");
}

function parseUniqueStringObject(text: string): Record<string, string> {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") throw new Error("Expected root object");
  index = skipJsonWhitespace(text, index + 1);
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (text[index] === "}") {
    index = skipJsonWhitespace(text, index + 1);
    if (index !== text.length) throw new Error("Unexpected trailing JSON");
    return result;
  }

  while (index < text.length) {
    const key = readJsonString(text, index);
    if (Object.hasOwn(result, key.value)) {
      throw new Error("Duplicate profile field");
    }
    index = skipJsonWhitespace(text, key.next);
    if (text[index] !== ":") throw new Error("Expected JSON colon");
    index = skipJsonWhitespace(text, index + 1);
    const value = readJsonString(text, index);
    result[key.value] = value.value;
    index = skipJsonWhitespace(text, value.next);
    if (text[index] === "}") {
      index = skipJsonWhitespace(text, index + 1);
      if (index !== text.length) throw new Error("Unexpected trailing JSON");
      return result;
    }
    if (text[index] !== ",") throw new Error("Expected JSON comma");
    index = skipJsonWhitespace(text, index + 1);
  }
  throw new Error("Unterminated root object");
}

async function readBoundedProfileJson(
  request: Request,
): Promise<Record<string, string>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_PROFILE_BODY_BYTES
    ) {
      throw new Error("Invalid profile body length");
    }
  }
  if (!request.body) throw new Error("Missing profile body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > MAX_PROFILE_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Profile body too large");
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
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return parseUniqueStringObject(text);
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    const identityFailure = identityResponse(
      user,
      authError,
      "read_identity",
    );
    if (identityFailure) return identityFailure;
    if (!user) return unavailable("read_identity_unexpected");

    const { data, error } = await supabase
      .from("profiles")
      .select("display_name, role_title, bio, avatar_url")
      .eq("id", user.id)
      .maybeSingle();
    if (error) return unavailable("read_profile");
    const stored = data ?? {
      display_name: null,
      role_title: null,
      bio: null,
      avatar_url: null,
    };
    if (!isStoredProfile(stored)) {
      return unavailable("read_profile_invalid");
    }
    if (!isBoundedNullableString(user.email ?? null, MAX_PROFILE_EMAIL_LENGTH)) {
      return unavailable("read_identity_invalid");
    }

    const payload: ProfilePayload = {
      subject: profileSubjectForUserId(user.id),
      display_name: stored.display_name,
      role_title: stored.role_title,
      bio: stored.bio,
      avatar_url: stored.avatar_url,
      email: user.email ?? null,
    };
    return NextResponse.json(payload);
  } catch {
    return unavailable("read_unexpected");
  }
}

export async function PATCH(request: Request) {
  try {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0];
    const origin = request.headers.get("origin");
    if (
      contentType !== "application/json" ||
      origin !== new URL(request.url).origin
    ) {
      return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }

    let record: Record<string, string>;
    try {
      record = await readBoundedProfileJson(request);
    } catch {
      return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }
    if (
      Object.keys(record).length !== PROFILE_KEYS.length ||
      !PROFILE_KEYS.every((key) => Object.hasOwn(record, key)) ||
      !isProfileSubject(record.subject) ||
      !PROFILE_KEYS.slice(1).every(
        (key) => record[key].length <= MAX_PROFILE_FIELD_LENGTH,
      )
    ) {
      return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    const identityFailure = identityResponse(
      user,
      authError,
      "write_identity",
    );
    if (identityFailure) return identityFailure;
    if (!user) return unavailable("write_identity_unexpected");

    const currentSubject = profileSubjectForUserId(user.id);
    if (record.subject !== currentSubject) {
      return NextResponse.json(
        { error: "PROFILE_SUBJECT_CHANGED" },
        { status: 409 },
      );
    }

    const { error } = await supabase.from("profiles").upsert({
      id: user.id,
      display_name: record.name.trim(),
      role_title: record.role.trim(),
      bio: record.bio.trim(),
      avatar_url: record.photo.trim(),
      updated_at: new Date().toISOString(),
    });
    if (error) return unavailable("write_profile");
    return NextResponse.json({ ok: true, subject: currentSubject });
  } catch {
    return unavailable("write_unexpected");
  }
}
