import { isAllowedAiMode } from "@/lib/ai/modes";

export type AIRequestPayload = {
  mode: string;
  text: string;
  body?: string;
  title?: string;
};

const MAX_AI_TEXT_CHARS = 20_000;
const MAX_AI_BODY_CHARS = 20_000;
const MAX_AI_TITLE_CHARS = 500;

function stringValue(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}

export function parseJsonBody<T>(body: string | undefined, fallback: T): T {
  if (!body) return fallback;
  try {
    return JSON.parse(body) as T;
  } catch {
    return fallback;
  }
}

export function normalizePayload(raw: unknown): { ok: true; payload: AIRequestPayload } | { ok: false; error: string; status: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid JSON payload", status: 400 };
  }
  const record = raw as Record<string, unknown>;
  const rawMode = stringValue(record.mode, 80)?.trim() || "capture";
  if (!isAllowedAiMode(rawMode)) {
    return { ok: false, error: `Unknown AI mode: ${rawMode}`, status: 400 };
  }
  const text = stringValue(record.text, MAX_AI_TEXT_CHARS);
  const body = stringValue(record.body, MAX_AI_BODY_CHARS);
  const title = stringValue(record.title, MAX_AI_TITLE_CHARS);
  if (text === undefined) return { ok: false, error: "text must be a string", status: 422 };
  if (record.body !== undefined && body === undefined) return { ok: false, error: "body must be a string", status: 422 };
  if (record.title !== undefined && title === undefined) return { ok: false, error: "title must be a string", status: 422 };
  return { ok: true, payload: { mode: rawMode, text, body, title } };
}
