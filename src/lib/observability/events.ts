/**
 * Structured observability events (program §13). A tiny, dependency-free helper
 * that builds redacted, structured log records for routine runs, step failures,
 * and integration health — so operational events are queryable and consistent,
 * and so we NEVER log secrets, tokens, or private financial content.
 *
 * The redaction guard is the important part and is unit-tested: any field whose
 * key looks sensitive (token/secret/password/authorization/cookie/api key/PII
 * identifiers) is masked before the record is emitted, defensively, regardless
 * of caller discipline.
 */

const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|auth|cookie|api[_-]?key|access[_-]?key|private[_-]?key|ssn|account[_-]?number|routing[_-]?number|card[_-]?number|cvv|email|phone)/i;

/** Recursively mask sensitive-looking keys in a plain object/array. */
export function redactSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((v) => redactSafe(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redactSafe(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type StructuredEvent = {
  event: string;
  ts: string;
  [key: string]: unknown;
};

/** Build a structured event record with its fields redacted. */
export function structuredEvent(
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date(),
): StructuredEvent {
  return { event, ts: now.toISOString(), ...(redactSafe(fields) as Record<string, unknown>) };
}

/**
 * Emit a structured event to the server log (captured by Vercel). Info-level and
 * intentionally cheap; errors still go through Sentry separately. Safe to call
 * with arbitrary fields — they are redacted first.
 */
export function emitServerEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify(structuredEvent(event, fields)));
}
