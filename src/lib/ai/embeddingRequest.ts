const MAX_EMBED_TEXT_CHARS = 12_000;
const MAX_SEMANTIC_QUERY_CHARS = 500;

export type EmbeddingPayload = {
  noteId: string;
  text: string;
};

function stringValue(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : undefined;
}

export function normalizeEmbeddingPayload(raw: unknown): { ok: true; payload: EmbeddingPayload } | { ok: false; error: string; status: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid JSON payload", status: 400 };
  }
  const record = raw as Record<string, unknown>;
  const noteId = stringValue(record.noteId, 200);
  const text = stringValue(record.text, MAX_EMBED_TEXT_CHARS);
  if (!noteId) return { ok: false, error: "noteId must be a non-empty string", status: 422 };
  if (!text) return { ok: false, error: "text must be a non-empty string", status: 422 };
  return { ok: true, payload: { noteId, text } };
}

export function normalizeSemanticQuery(value: string | null): { ok: true; query: string } | { ok: false; error: string; status: number } {
  const query = stringValue(value, MAX_SEMANTIC_QUERY_CHARS);
  if (!query) return { ok: false, error: "Missing query param q", status: 400 };
  return { ok: true, query };
}
