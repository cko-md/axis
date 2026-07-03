export type SignalAIInput = {
  id?: string;
  title: string;
  body?: string | null;
  source?: string | null;
};

export type SignalAIRequest =
  | { mode: "single"; input: SignalAIInput }
  | { mode: "batch"; signals: SignalAIInput[] };

const MAX_SIGNAL_TITLE_CHARS = 500;
const MAX_SIGNAL_BODY_CHARS = 4_000;
const MAX_SIGNAL_SOURCE_CHARS = 200;
const MAX_SIGNAL_ID_CHARS = 200;
const MAX_BATCH_SIZE = 50;

function optionalString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : undefined;
}

function normalizeInput(raw: unknown): SignalAIInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = optionalString(record.title, MAX_SIGNAL_TITLE_CHARS);
  if (!title) return null;
  const body = record.body === null ? null : optionalString(record.body, MAX_SIGNAL_BODY_CHARS);
  const source = record.source === null ? null : optionalString(record.source, MAX_SIGNAL_SOURCE_CHARS);
  const id = optionalString(record.id, MAX_SIGNAL_ID_CHARS);
  return { id, title, body: body ?? null, source: source ?? null };
}

export function normalizeSignalsAIRequest(raw: unknown): { ok: true; request: SignalAIRequest } | { ok: false; error: string; status: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid JSON payload", status: 400 };
  }
  const record = raw as Record<string, unknown>;
  if (record.mode === "batch") {
    if (!Array.isArray(record.signals)) {
      return { ok: false, error: "signals must be an array", status: 422 };
    }
    if (record.signals.length > MAX_BATCH_SIZE) {
      return { ok: false, error: "Batch size exceeds limit of 50", status: 400 };
    }
    const signals = record.signals.map(normalizeInput);
    if (signals.some((signal) => signal === null)) {
      return { ok: false, error: "Each signal needs a non-empty string title", status: 422 };
    }
    return { ok: true, request: { mode: "batch", signals: signals as SignalAIInput[] } };
  }

  const input = normalizeInput(record);
  if (!input) {
    return { ok: false, error: "title must be a non-empty string", status: 422 };
  }
  return { ok: true, request: { mode: "single", input } };
}
