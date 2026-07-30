import type { Breadcrumb, Event } from "@sentry/nextjs";
import type { SpanJSON, TransactionEvent } from "@sentry/core";

type SentryRequest = NonNullable<Event["request"]>;

const SECRET_KEY_RE = /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|body|html|messageText|messageHtml|mailBody|emailBody|rawEmail|challenge|credential|clientDataJSON|attestationObject|authenticatorData|signature|userHandle|rawId)/i;
const TARGET_KEY_SEGMENTS = new Set([
  "url", "uri", "href", "feed", "feeds", "feedurl", "feedurls", "target",
  "referer", "referrer", "peer", "host", "address", "ip", "port",
]);
const BREADCRUMB_TEXT_KEY_SEGMENTS = new Set([
  "message", "description", "previous", "current", "from", "to", "path", "pathname", "location",
]);
const WEBAUTHN_ROUTE_RE = /\/api\/(?:auth\/passkey\/|approvals\/[^/?]+\/step-up(?:[/?]|$))/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s"'<>()]+/gi, "[REDACTED_URL]")
    .replace(EMAIL_RE, "[REDACTED_EMAIL]");
}

function isTargetBearingKey(key: string): boolean {
  // Split dot/dash/underscore keys and camelCase attributes without treating
  // unrelated words such as security, feedback, or transport as sensitive.
  const segments = key.replace(/([a-z0-9])([A-Z])/g, "$1.$2").split(/[._-]/).map((segment) => segment.toLowerCase());
  return segments.some((segment) => TARGET_KEY_SEGMENTS.has(segment));
}

function scrubTraceText(value: string): string {
  if (/(?:https?|wss?):\/\//i.test(value) || /[?#]/.test(value) || /(?:^|\s)\/\S*/.test(value)) return REDACTED;
  return redactString(value);
}

function scrubBreadcrumbValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubBreadcrumbValue(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key) || isTargetBearingKey(key)) result[key] = REDACTED;
    else if (BREADCRUMB_TEXT_KEY_SEGMENTS.has(key.toLowerCase()) && typeof nested === "string") result[key] = scrubTraceText(nested);
    else result[key] = scrubBreadcrumbValue(nested, depth + 1);
  }
  return result;
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_RE.test(key) || isTargetBearingKey(key) ? REDACTED : scrubValue(nested, depth + 1);
  }
  return result;
}

function scrubRequest(event: Event): void {
  const request = event.request;
  if (!request) return;
  const isWebAuthnRoute = typeof request.url === "string" && WEBAUTHN_ROUTE_RE.test(request.url);

  if (request.headers) {
    const safeHeaders: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      safeHeaders[key] = SECRET_KEY_RE.test(key) || isTargetBearingKey(key) ? REDACTED : scrubValue(value);
    }
    request.headers = safeHeaders as SentryRequest["headers"];
  }

  request.cookies = undefined;
  // Event transactions already carry the normalized route. Never preserve a
  // raw request payload, query string, fragment, or dynamic path here.
  request.data = isWebAuthnRoute ? REDACTED : undefined;
  request.query_string = undefined;
  if (request.url) request.url = REDACTED;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  scrubRequest(event);

  event.extra = scrubValue(event.extra) as Event["extra"];
  event.contexts = scrubValue(event.contexts) as Event["contexts"];
  event.tags = scrubValue(event.tags) as Event["tags"];
  event.breadcrumbs = scrubBreadcrumbValue(event.breadcrumbs) as Event["breadcrumbs"];

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

/** Scrubs transaction payloads, which bypass Sentry's beforeSend hook. */
export function scrubSentryTransaction<T extends TransactionEvent>(event: T): T {
  scrubSentryEvent(event);
  const source = event.transaction_info?.source;
  // Sentry's route source is normalized by the SDK/framework; preserve it as
  // the safe route label. Every other transaction name may be raw input.
  if (event.transaction && (source !== "route" || /(?:https?|wss?):\/\//i.test(event.transaction) || /[?#]/.test(event.transaction))) {
    event.transaction = REDACTED;
  }
  if (event.spans) event.spans = event.spans.map((span) => scrubSentrySpan(span));
  return event;
}

/** Scrubs native HTTP span attributes such as http.url and url.full. */
export function scrubSentrySpan<T extends SpanJSON>(span: T): T {
  span.data = scrubValue(span.data) as SpanJSON["data"];
  if (span.description) span.description = scrubTraceText(span.description);
  if (span.links) span.links = scrubValue(span.links) as SpanJSON["links"];
  return span;
}

/** Scrubs breadcrumbs at capture time so trace-only envelopes cannot retain targets. */
export function scrubSentryBreadcrumb<T extends Breadcrumb>(breadcrumb: T): T {
  if (breadcrumb.data) breadcrumb.data = scrubBreadcrumbValue(breadcrumb.data) as Breadcrumb["data"];
  if (breadcrumb.message) breadcrumb.message = scrubTraceText(breadcrumb.message);
  return breadcrumb;
}
