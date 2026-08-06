import { NextResponse } from "next/server";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { isProfileSubject } from "@/lib/auth/profileSubject";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { parsePreferenceEnvelopeStrict } from "@/lib/theme/preferences";

const ROUTE = "/api/auth/preferences";
const MAX_BODY_BYTES = 128 * 1_024;
const MAX_JSON_DEPTH = 12;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type PreferenceEnvelope = Record<string, Json | undefined>;

function unavailable(operation: "read" | "save") {
  captureRouteError(new Error("Interface preferences operation failed"), {
    route: ROUTE,
    area: "profile",
    provider: "supabase",
    operation,
    status: 500,
    code: operation === "read" ? "PROFILE_LOAD_FAILED" : "PROFILE_SAVE_FAILED",
  });
  return NextResponse.json(
    { error: "PREFERENCES_UNAVAILABLE" },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function aborted() {
  return response({ error: "REQUEST_ABORTED" }, 499);
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

function identityResponse(
  user: unknown,
  error: unknown,
  operation: "read" | "save",
) {
  if (isMissingSession(error) || (!error && !user)) {
    return response({ error: "UNAUTHENTICATED" }, 401);
  }
  if (error) return unavailable(operation);
  return null;
}

async function getAuthenticatedUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  try {
    return await supabase.auth.getUser();
  } catch (error) {
    if (isMissingSession(error)) {
      return { data: { user: null }, error };
    }
    throw error;
  }
}

function isJsonValue(value: unknown, depth = 0): value is Json {
  if (depth > MAX_JSON_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, entry]) =>
      !UNSAFE_KEYS.has(key) &&
      entry !== undefined &&
      isJsonValue(entry, depth + 1),
  );
}

function isPreferenceEnvelope(value: unknown): value is PreferenceEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

function serializedWithinLimit(value: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BODY_BYTES;
  } catch {
    return false;
  }
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
      const value: unknown = JSON.parse(text.slice(start, index + 1));
      if (typeof value !== "string") throw new Error("Invalid JSON string");
      return { next: index + 1, value };
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

function parseUniqueJsonValue(text: string, start: number, depth: number): number {
  if (depth > 32) throw new Error("JSON nesting too deep");
  const index = skipJsonWhitespace(text, start);
  const character = text[index];
  if (character === '"') return readJsonString(text, index).next;
  if (character === "{") {
    let cursor = skipJsonWhitespace(text, index + 1);
    const keys = new Set<string>();
    if (text[cursor] === "}") return cursor + 1;
    while (cursor < text.length) {
      const key = readJsonString(text, cursor);
      if (keys.has(key.value)) throw new Error("Duplicate JSON key");
      keys.add(key.value);
      cursor = skipJsonWhitespace(text, key.next);
      if (text[cursor] !== ":") throw new Error("Expected JSON colon");
      cursor = skipJsonWhitespace(
        text,
        parseUniqueJsonValue(text, cursor + 1, depth + 1),
      );
      if (text[cursor] === "}") return cursor + 1;
      if (text[cursor] !== ",") throw new Error("Expected JSON comma");
      cursor = skipJsonWhitespace(text, cursor + 1);
    }
    throw new Error("Unterminated JSON object");
  }
  if (character === "[") {
    let cursor = skipJsonWhitespace(text, index + 1);
    if (text[cursor] === "]") return cursor + 1;
    while (cursor < text.length) {
      cursor = skipJsonWhitespace(
        text,
        parseUniqueJsonValue(text, cursor, depth + 1),
      );
      if (text[cursor] === "]") return cursor + 1;
      if (text[cursor] !== ",") throw new Error("Expected JSON comma");
      cursor = skipJsonWhitespace(text, cursor + 1);
    }
    throw new Error("Unterminated JSON array");
  }
  const remainder = text.slice(index);
  const primitive = remainder.match(
    /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
  );
  if (!primitive) throw new Error("Invalid JSON value");
  return index + primitive[0].length;
}

function assertUniqueJsonKeys(text: string) {
  const end = skipJsonWhitespace(text, parseUniqueJsonValue(text, 0, 0));
  if (end !== text.length) throw new Error("Unexpected trailing JSON");
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_BODY_BYTES
    ) {
      throw new Error("Invalid preferences body length");
    }
  }
  if (!request.body) throw new Error("Missing preferences body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Preferences body too large");
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
  assertUniqueJsonKeys(text);
  return JSON.parse(text);
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await getAuthenticatedUser(supabase);
    const identityFailure = identityResponse(user, authError, "read");
    if (identityFailure) return identityFailure;
    if (!user) return unavailable("read");
    if (request.signal.aborted) return aborted();
    return response({ subject: profileSubjectForUserId(user.id) });
  } catch {
    return request.signal.aborted ? aborted() : unavailable("read");
  }
}

export async function PUT(request: Request) {
  try {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0];
    const origin = request.headers.get("origin");
    if (
      contentType !== "application/json" ||
      origin !== new URL(request.url).origin
    ) {
      return response({ error: "INVALID_PREFERENCES" }, 400);
    }

    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch {
      return response({ error: "INVALID_PREFERENCES" }, 400);
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, "subject") ||
      !Object.hasOwn(body, "envelope")
    ) {
      return response({ error: "INVALID_PREFERENCES" }, 400);
    }
    const record = body as Record<string, unknown>;
    if (
      !isProfileSubject(record.subject) ||
      !isPreferenceEnvelope(record.envelope) ||
      !serializedWithinLimit(record.envelope) ||
      !parsePreferenceEnvelopeStrict(record.envelope)
    ) {
      return response({ error: "INVALID_PREFERENCES" }, 400);
    }

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await getAuthenticatedUser(supabase);
    const identityFailure = identityResponse(user, authError, "save");
    if (identityFailure) return identityFailure;
    if (!user) return unavailable("save");

    const currentSubject = profileSubjectForUserId(user.id);
    if (record.subject !== currentSubject) {
      return response({ error: "PROFILE_SUBJECT_CHANGED" }, 409);
    }

    const { error } = await supabase
      .from("user_preferences")
      .upsert(
        {
          user_id: user.id,
          interface_settings: record.envelope as Json,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .abortSignal(request.signal);
    if (request.signal.aborted) return aborted();
    if (error) return unavailable("save");
    return response({ ok: true, subject: currentSubject });
  } catch {
    return request.signal.aborted ? aborted() : unavailable("save");
  }
}
