import type { Json } from "@/lib/supabase/database.types";

/**
 * Locale-independent UTF-16 code-unit ordering.
 *
 * VECTOR device identifiers are ASCII, so this ordering is also bytewise and
 * agrees with deterministic PostgreSQL text ordering for every valid ID.
 */
export function compareVectorText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stableValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, Json] => entry[1] !== undefined)
        .sort(([left], [right]) => compareVectorText(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function canonicalVectorJson(value: Json): string {
  return JSON.stringify(stableValue(value));
}

export function vectorJsonBytes(value: Json): number {
  return new TextEncoder().encode(canonicalVectorJson(value)).byteLength;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checksumVectorState(value: Json): Promise<string> {
  return sha256Hex(canonicalVectorJson(value));
}

export async function hashVectorPayload(value: Json): Promise<string> {
  return sha256Hex(canonicalVectorJson(value));
}
