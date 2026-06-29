import type { Event } from "@sentry/nextjs";

type SentryRequest = NonNullable<Event["request"]>;

const SECRET_KEY_RE = /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|body|html|messageText|messageHtml|mailBody|emailBody|rawEmail)/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return value.replace(EMAIL_RE, "[REDACTED_EMAIL]");
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_RE.test(key) ? REDACTED : scrubValue(nested, depth + 1);
  }
  return result;
}

function scrubRequest(event: Event): void {
  const request = event.request;
  if (!request) return;

  if (request.headers) {
    const safeHeaders: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      safeHeaders[key] = SECRET_KEY_RE.test(key) ? REDACTED : scrubValue(value);
    }
    request.headers = safeHeaders as SentryRequest["headers"];
  }

  request.cookies = undefined;
  request.data = scrubValue(request.data) as SentryRequest["data"];
  request.query_string = scrubValue(request.query_string) as SentryRequest["query_string"];
  if (request.url) request.url = redactString(request.url);
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  scrubRequest(event);

  event.extra = scrubValue(event.extra) as Event["extra"];
  event.contexts = scrubValue(event.contexts) as Event["contexts"];
  event.tags = scrubValue(event.tags) as Event["tags"];

  if (event.user) {
    event.user.email = undefined;
    event.user.ip_address = undefined;
    event.user.username = event.user.username ? redactString(event.user.username) : undefined;
  }

  if (event.message) event.message = redactString(event.message);

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => ({
      ...exception,
      value: typeof exception.value === "string" ? redactString(exception.value) : exception.value,
    }));
  }

  return event;
}
