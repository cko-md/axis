import type { Breadcrumb, Event } from "@sentry/nextjs";
import type { SpanJSON, TransactionEvent } from "@sentry/core";

type SentryRequest = NonNullable<Event["request"]>;

const SECRET_KEY_RE = /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|body|html|messageText|messageHtml|mailBody|emailBody|rawEmail|challenge|credential|clientDataJSON|attestationObject|authenticatorData|signature|userHandle|rawId)/i;
const TARGET_KEY_SEGMENTS = new Set([
  "url", "uri", "href", "feed", "feeds", "feedurl", "feedurls", "target",
  "referer", "referrer", "peer", "host", "address", "ip", "port",
  "query", "querystring", "search", "searchparams", "fragment", "hash",
]);
const BREADCRUMB_TEXT_KEY_SEGMENTS = new Set([
  "message", "description", "previous", "current", "from", "to", "path", "pathname", "location",
]);
const WEBAUTHN_ROUTE_RE = /\/api\/(?:auth\/passkey\/|approvals\/[^/?]+\/step-up(?:[/?]|$))/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REDACTED = "[REDACTED]";

function redactLegacyString(value: string): string {
  return value.replace(EMAIL_RE, "[REDACTED_EMAIL]");
}

function redactStrictString(value: string): string {
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
  return redactStrictString(value);
}

function scrubBreadcrumbValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactStrictString(value);
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

function scrubLegacyValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactLegacyString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubLegacyValue(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_RE.test(key) ? REDACTED : scrubLegacyValue(nested, depth + 1);
  }
  return result;
}

function scrubStrictValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (typeof value === "string") return redactStrictString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubStrictValue(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_RE.test(key) || isTargetBearingKey(key) ? REDACTED : scrubStrictValue(nested, depth + 1);
  }
  return result;
}

function scrubLegacyRequest(event: Event): void {
  const request = event.request;
  if (!request) return;
  const isWebAuthnRoute = typeof request.url === "string" && WEBAUTHN_ROUTE_RE.test(request.url);

  if (request.headers) {
    const safeHeaders: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      safeHeaders[key] = SECRET_KEY_RE.test(key) ? REDACTED : scrubLegacyValue(value);
    }
    request.headers = safeHeaders as SentryRequest["headers"];
  }

  request.cookies = undefined;
  request.data = (isWebAuthnRoute ? REDACTED : scrubLegacyValue(request.data)) as SentryRequest["data"];
  request.query_string = scrubLegacyValue(request.query_string) as SentryRequest["query_string"];
  if (request.url) request.url = redactLegacyString(request.url);
}

/**
 * Legacy public contract retained for protected callers: recursively redact
 * secrets while retaining sanitized request diagnostics. Sentry transports
 * must use scrubSentryEventStrict instead.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  scrubLegacyRequest(event);

  event.extra = scrubLegacyValue(event.extra) as Event["extra"];
  event.contexts = scrubLegacyValue(event.contexts) as Event["contexts"];
  event.tags = scrubLegacyValue(event.tags) as Event["tags"];

  if (event.user) {
    event.user.email = undefined;
    event.user.ip_address = undefined;
    event.user.username = event.user.username ? redactLegacyString(event.user.username) : undefined;
  }

  if (event.message) event.message = redactLegacyString(event.message);

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => ({
      ...exception,
      value: typeof exception.value === "string" ? redactLegacyString(exception.value) : exception.value,
    }));
  }

  return event;
}

/** Strict production transport hook: removes targets and request payloads. */
export function scrubSentryEventStrict<T extends Event>(event: T): T {
  scrubSentryEvent(event);
  const request = event.request;
  if (request) {
    if (request.headers) {
      const safeHeaders: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        safeHeaders[key] = SECRET_KEY_RE.test(key) || isTargetBearingKey(key) ? REDACTED : scrubStrictValue(value);
      }
      request.headers = safeHeaders as SentryRequest["headers"];
    }
    request.cookies = undefined;
    request.data = typeof request.url === "string" && WEBAUTHN_ROUTE_RE.test(request.url) ? REDACTED : undefined;
    request.query_string = undefined;
    request.url = REDACTED;
  }

  event.extra = scrubStrictValue(event.extra) as Event["extra"];
  event.contexts = scrubStrictValue(event.contexts) as Event["contexts"];
  event.tags = scrubStrictValue(event.tags) as Event["tags"];
  event.breadcrumbs = scrubBreadcrumbValue(event.breadcrumbs) as Event["breadcrumbs"];
  if (event.user?.username) event.user.username = scrubTraceText(event.user.username);
  if (event.message) event.message = scrubTraceText(event.message);
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => ({
      ...exception,
      value: typeof exception.value === "string" ? scrubTraceText(exception.value) : exception.value,
    }));
  }
  return event;
}

/** Scrubs transaction payloads, which bypass Sentry's beforeSend hook. */
export function scrubSentryTransaction<T extends TransactionEvent>(event: T): T {
  scrubSentryEventStrict(event);
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
  span.data = scrubStrictValue(span.data) as SpanJSON["data"];
  if (span.description) span.description = scrubTraceText(span.description);
  if (span.links) span.links = scrubStrictValue(span.links) as SpanJSON["links"];
  return span;
}

/** Scrubs breadcrumbs at capture time so trace-only envelopes cannot retain targets. */
export function scrubSentryBreadcrumb<T extends Breadcrumb>(breadcrumb: T): T {
  if (breadcrumb.data) breadcrumb.data = scrubBreadcrumbValue(breadcrumb.data) as Breadcrumb["data"];
  if (breadcrumb.message) breadcrumb.message = scrubTraceText(breadcrumb.message);
  return breadcrumb;
}
