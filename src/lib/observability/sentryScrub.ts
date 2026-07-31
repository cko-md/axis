import type { Breadcrumb, Event } from "@sentry/nextjs";
import type { SpanJSON, TransactionEvent } from "@sentry/core";
import { AXIS_ROUTE_SET } from "./axisRouteManifest";
import { AXIS_TELEMETRY_SETS } from "./telemetryVocabulary";

type SentryRequest = NonNullable<Event["request"]>;

const SECRET_KEY_RE = /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|body|html|messageText|messageHtml|mailBody|emailBody|rawEmail|challenge|credential|clientDataJSON|attestationObject|authenticatorData|signature|userHandle|rawId)/i;
const WEBAUTHN_ROUTE_RE = /\/api\/(?:auth\/passkey\/|approvals\/[^/?]+\/step-up(?:[/?]|$))/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REDACTED = "[REDACTED]";

function redactLegacyString(value: string): string {
  return value.replace(EMAIL_RE, "[REDACTED_EMAIL]");
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

/* Strict boundary: fixed own-data descriptors in, new null-prototype values out. */
const MAX_DEPTH = 5;
const MAX_BREADCRUMBS = 100;
const MAX_SPANS = 1000;
const MAX_LINKS = 16;
const MAX_OTHER_ARRAY = 32;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const EVENT_LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const ENVIRONMENTS = new Set(["production", "preview", "development", "test"]);
const STATUSES = new Set(["ok", "deadline_exceeded", "unauthenticated", "permission_denied", "not_found", "resource_exhausted", "invalid_argument", "unimplemented", "unavailable", "internal_error", "unknown_error", "cancelled", "already_exists", "failed_precondition", "aborted", "out_of_range", "data_loss"]);
const SPAN_OPS = new Set(["http.server", "http.client", "pageload", "navigation", "function.server_action", "ui.action.click"]);
const BREADCRUMB_CATEGORIES = new Set(["safe-fetch", "provider.retry", "provider.failure", "provider.slow", "route.error", "widget.batch", "widget.partial", "tasks"]);
const BREADCRUMB_TYPES = new Set(["default", "error", "navigation", "http"]);
const OUTCOMES = new Set(["ok", "error", "slow"]);
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
type PlainObject = Record<string, unknown>;

function record(): PlainObject { return Object.create(null) as PlainObject; }
function list<T>(): T[] { const output: T[] = []; Object.setPrototypeOf(output, null); return output; }
function append<T>(output: T[], value: T): void { output[output.length] = value; }
function ownData(input: unknown, key: string): unknown {
  if ((typeof input !== "object" || input === null) && typeof input !== "function") return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(input, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; } catch { return undefined; }
}
function object(value: unknown): object | undefined { return typeof value === "object" && value !== null ? value : undefined; }
function valid(value: unknown, set: ReadonlySet<string>): value is string { return typeof value === "string" && set.has(value); }
function traceId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
function spanId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{16}$/.test(value); }
function route(value: unknown): value is string { return typeof value === "string" && AXIS_ROUTE_SET.has(value); }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 253402300799; }
function number(value: unknown, min: number, max: number, integer = false): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)); }
function status(value: unknown): number | undefined { if (number(value, 100, 599, true)) return value; if (typeof value === "string" && /^(?:[1-5][0-9]{2})$/.test(value)) return Number(value); return undefined; }
function operation(value: unknown): value is string { return valid(value, AXIS_TELEMETRY_SETS.operations); }
function spanOperation(value: unknown): value is string { return valid(value, SPAN_OPS) || operation(value); }
function firstRegistered(candidates: readonly unknown[], registry: ReadonlySet<string>): string | undefined { for (const candidate of candidates) if (valid(candidate, registry)) return candidate; return undefined; }
function firstStatus(candidates: readonly unknown[]): number | undefined { for (const candidate of candidates) { const normalized = status(candidate); if (normalized !== undefined) return normalized; } return undefined; }
function nonempty(value: PlainObject, keys: readonly string[]): boolean { for (const key of keys) if (ownData(value, key) !== undefined) return true; return false; }
function guarded<T>(value: unknown, stack: WeakSet<object>, depth: number, build: (input: object) => T | undefined): T | undefined {
  const input = object(value); if (!input || depth > MAX_DEPTH || stack.has(input)) return undefined;
  stack.add(input); try { return build(input); } catch { return undefined; } finally { stack.delete(input); }
}
function arrayLength(value: object, maximum: number): number { try { if (!Array.isArray(value)) return 0; const length = ownData(value, "length"); return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? Math.min(length, maximum) : 0; } catch { return 0; } }

function metadata(value: unknown, stack: WeakSet<object>, depth: number, allowRoute: boolean): PlainObject | undefined {
  return guarded(value, stack, depth, (input) => {
    const output = record();
    const area = ownData(input, "area"), provider = ownData(input, "provider"), transport = ownData(input, "transport"), via = ownData(input, "via"), operationPrimary = ownData(input, "operation"), operationAlias = ownData(input, "op"), codePrimary = ownData(input, "code"), errorCode = ownData(input, "error_code"), supabaseCode = ownData(input, "supabase_code"), statusPrimary = ownData(input, "status"), httpStatus = ownData(input, "http_status"), statusCode = ownData(input, "status_code"), httpStatusCode = ownData(input, "http.status_code"), outcome = ownData(input, "outcome");
    const rawOperation = firstRegistered([operationPrimary, operationAlias], AXIS_TELEMETRY_SETS.operations);
    const code = firstRegistered([codePrimary, errorCode, supabaseCode], AXIS_TELEMETRY_SETS.codes);
    const rawStatus = firstStatus([statusPrimary, httpStatus, statusCode, httpStatusCode]);
    const durationMs = ownData(input, "durationMs"), delayMs = ownData(input, "delayMs"), attempt = ownData(input, "attempt"), attempted = ownData(input, "attempted"), disconnected = ownData(input, "disconnected"), failed = ownData(input, "failed"), queryLength = ownData(input, "queryLength"), encodedLength = ownData(input, "encoded_length"), requestBody = ownData(input, "request_body_size"), responseBody = ownData(input, "response_body_size");
    const retryable = ownData(input, "retryable"), partial = ownData(input, "partial"), fallback = ownData(input, "fallback"), sampled = ownData(input, "sampled"), segment = ownData(input, "is_segment"), handled = ownData(input, "handled"), synthetic = ownData(input, "synthetic"), grouped = ownData(input, "is_exception_group");
    if (valid(area, AXIS_TELEMETRY_SETS.areas)) output.area = area;
    if (valid(provider, AXIS_TELEMETRY_SETS.providers)) output.provider = provider;
    if (valid(transport, AXIS_TELEMETRY_SETS.transports)) output.transport = transport;
    if (valid(via, AXIS_TELEMETRY_SETS.transports)) output.via = via;
    if (operation(rawOperation)) output.operation = rawOperation;
    if (valid(code, AXIS_TELEMETRY_SETS.codes)) output.code = code;
    if (rawStatus !== undefined) output.status = rawStatus;
    if (valid(outcome, OUTCOMES)) output.outcome = outcome;
    if (number(durationMs, 0, 2678400000, true)) output.durationMs = durationMs;
    if (number(delayMs, 0, 2678400000, true)) output.delayMs = delayMs;
    if (number(attempt, 1, 10, true)) output.attempt = attempt;
    if (number(attempted, 0, 1_000_000, true)) output.attempted = attempted;
    if (number(disconnected, 0, 1_000_000, true)) output.disconnected = disconnected;
    if (number(failed, 0, 1_000_000, true)) output.failed = failed;
    if (number(queryLength, 0, 1_000_000, true)) output.queryLength = queryLength;
    if (number(encodedLength, 0, 1_000_000, true)) output.encoded_length = encodedLength;
    if (number(requestBody, 0, 10_000_000, true)) output.request_body_size = requestBody;
    if (number(responseBody, 0, 10_000_000, true)) output.response_body_size = responseBody;
    if (typeof retryable === "boolean") output.retryable = retryable;
    if (typeof partial === "boolean") output.partial = partial;
    if (typeof fallback === "boolean") output.fallback = fallback;
    if (typeof sampled === "boolean") output.sampled = sampled;
    if (typeof segment === "boolean") output.is_segment = segment;
    if (typeof handled === "boolean") output.handled = handled;
    if (typeof synthetic === "boolean") output.synthetic = synthetic;
    if (typeof grouped === "boolean") output.is_exception_group = grouped;
    if (allowRoute) { const safeRoute = ownData(input, "http.route"); if (route(safeRoute)) output["http.route"] = safeRoute; }
    return output;
  });
}
function tags(value: unknown, stack: WeakSet<object>, depth: number): PlainObject | undefined {
  return guarded(value, stack, depth, (input) => {
    const output = metadata(input, new WeakSet<object>(), depth + 1, false) ?? record();
    const safeRoute = ownData(input, "route"); if (route(safeRoute)) output.route = safeRoute;
    return output;
  });
}
function links(value: unknown, stack: WeakSet<object>, depth: number): PlainObject[] | undefined {
  return guarded(value, stack, depth, (input) => { const output = list<PlainObject>(); const length = arrayLength(input, MAX_LINKS); for (let i = 0; i < length; i += 1) { const link = guarded(ownData(input, `${i}`), stack, depth + 1, (entry) => { const built = record(); const trace = ownData(entry, "trace_id"), span = ownData(entry, "span_id"); if (traceId(trace)) built.trace_id = trace; if (spanId(span)) built.span_id = span; return built; }); if (link) append(output, link); } return output; });
}
function traceContext(value: unknown, stack: WeakSet<object>, depth: number): PlainObject | undefined {
  return guarded(value, stack, depth, (input) => { const output = record(); const trace = ownData(input, "trace_id"), span = ownData(input, "span_id"), parent = ownData(input, "parent_span_id"), rawStatus = ownData(input, "status"), op = ownData(input, "op"), segment = ownData(input, "segment_id"), exclusive = ownData(input, "exclusive_time"); const data = metadata(ownData(input, "data"), stack, depth + 1, true); const safeLinks = links(ownData(input, "links"), stack, depth + 1); if (traceId(trace)) output.trace_id = trace; if (spanId(span)) output.span_id = span; if (spanId(parent)) output.parent_span_id = parent; if (valid(rawStatus, STATUSES)) output.status = rawStatus; if (spanOperation(op)) output.op = op; if (spanId(segment)) output.segment_id = segment; if (number(exclusive, 0, 2678400000)) output.exclusive_time = exclusive; if (data && nonempty(data, ["area", "provider", "operation", "code", "http.route"])) output.data = data; if (safeLinks && safeLinks.length > 0) output.links = safeLinks; return output; });
}
function contexts(value: unknown, stack: WeakSet<object>, depth: number): PlainObject | undefined {
  return guarded(value, stack, depth, (input) => { const output = record(); const safeFetch = metadata(ownData(input, "safe_fetch"), stack, depth + 1, false); const providerCall = metadata(ownData(input, "providerCall"), stack, depth + 1, false); const composio = metadata(ownData(input, "composio"), stack, depth + 1, false); const supabase = metadata(ownData(input, "supabase"), stack, depth + 1, false); const trace = traceContext(ownData(input, "trace"), stack, depth + 1); if (safeFetch && nonempty(safeFetch, ["area", "operation", "code"])) output.safe_fetch = safeFetch; if (providerCall && nonempty(providerCall, ["area", "provider", "operation", "code", "status", "outcome", "durationMs"])) output.providerCall = providerCall; if (composio && nonempty(composio, ["area", "provider", "operation", "code", "status"])) output.composio = composio; if (supabase && nonempty(supabase, ["area", "provider", "operation", "code", "status"])) output.supabase = supabase; if (trace && nonempty(trace, ["trace_id", "span_id", "op", "data"])) output.trace = trace; return output; });
}
function breadcrumb(value: unknown, stack = new WeakSet<object>(), depth = 0): Breadcrumb {
  const built = guarded(value, stack, depth, (input) => { const output = record(); const eventId = ownData(input, "event_id"), time = ownData(input, "timestamp"), level = ownData(input, "level"), category = ownData(input, "category"), type = ownData(input, "type"), data = metadata(ownData(input, "data"), stack, depth + 1, false); if (traceId(eventId)) output.event_id = eventId; if (timestamp(time)) output.timestamp = time; if (valid(level, EVENT_LEVELS)) output.level = level; if (valid(category, BREADCRUMB_CATEGORIES)) output.category = category; if (valid(type, BREADCRUMB_TYPES)) output.type = type; if (data && nonempty(data, ["area", "provider", "operation", "code", "status", "outcome", "durationMs"])) output.data = data; return output; }); return (built ?? record()) as Breadcrumb;
}
function breadcrumbs(value: unknown, stack: WeakSet<object>, depth: number): Breadcrumb[] | undefined { return guarded(value, stack, depth, (input) => { const output = list<Breadcrumb>(); const length = arrayLength(input, MAX_BREADCRUMBS); for (let i = 0; i < length; i += 1) append(output, breadcrumb(ownData(input, `${i}`), stack, depth + 1)); return output; }); }
function span(value: unknown, stack = new WeakSet<object>(), depth = 0): SpanJSON {
  const built = guarded(value, stack, depth, (input) => { const output = record(); const trace = ownData(input, "trace_id"), id = ownData(input, "span_id"), parent = ownData(input, "parent_span_id"), start = ownData(input, "start_timestamp"), end = ownData(input, "timestamp"), rawStatus = ownData(input, "status"), op = ownData(input, "op"), segment = ownData(input, "segment_id"), exclusive = ownData(input, "exclusive_time"), isSegment = ownData(input, "is_segment"); const data = metadata(ownData(input, "data"), stack, depth + 1, true); const safeLinks = links(ownData(input, "links"), stack, depth + 1); output.trace_id = traceId(trace) ? trace : ZERO_TRACE_ID; output.span_id = spanId(id) ? id : ZERO_SPAN_ID; output.start_timestamp = timestamp(start) ? start : 0; if (spanId(parent)) output.parent_span_id = parent; if (timestamp(end)) output.timestamp = end; if (valid(rawStatus, STATUSES)) output.status = rawStatus; if (spanOperation(op)) output.op = op; if (spanId(segment)) output.segment_id = segment; if (number(exclusive, 0, 2678400000)) output.exclusive_time = exclusive; if (typeof isSegment === "boolean") output.is_segment = isSegment; if (data && nonempty(data, ["area", "provider", "operation", "code", "http.route"])) output.data = data; if (safeLinks && safeLinks.length > 0) output.links = safeLinks; return output; }); const fallback = record(); fallback.trace_id = ZERO_TRACE_ID; fallback.span_id = ZERO_SPAN_ID; fallback.start_timestamp = 0; return (built ?? fallback) as unknown as SpanJSON;
}
function spans(value: unknown, stack: WeakSet<object>, depth: number): SpanJSON[] | undefined { return guarded(value, stack, depth, (input) => { const output = list<SpanJSON>(); const length = arrayLength(input, MAX_SPANS); for (let i = 0; i < length; i += 1) append(output, span(ownData(input, `${i}`), stack, depth + 1)); return output; }); }
function sdk(value: unknown, stack: WeakSet<object>, depth: number): PlainObject | undefined { return guarded(value, stack, depth, (input) => { const name = ownData(input, "name"), version = ownData(input, "version"); if (name !== "sentry.javascript.nextjs" || version !== "10.59.0") return undefined; const output = record(); output.name = name; output.version = version; return output; }); }
function exception(value: unknown, stack: WeakSet<object>, depth: number): PlainObject | undefined { return guarded(value, stack, depth, (input) => { const values = ownData(input, "values"); let code: string | undefined; let mechanism: PlainObject | undefined; guarded(values, stack, depth + 1, (items) => { if (arrayLength(items, MAX_OTHER_ARRAY) === 0) return undefined; return guarded(ownData(items, "0"), stack, depth + 2, (first) => { const candidate = ownData(first, "value") ?? ownData(first, "type"); if (valid(candidate, AXIS_TELEMETRY_SETS.codes)) code = candidate; return guarded(ownData(first, "mechanism"), stack, depth + 3, (raw) => { const output = record(); const handled = ownData(raw, "handled"), synthetic = ownData(raw, "synthetic"), group = ownData(raw, "is_exception_group"); if (typeof handled === "boolean") output.handled = handled; if (typeof synthetic === "boolean") output.synthetic = synthetic; if (typeof group === "boolean") output.is_exception_group = group; mechanism = output; return output; }); }); }); const item = record(); item.type = "Error"; item.value = code ?? "AXIS_REDACTED_ERROR"; if (mechanism && nonempty(mechanism, ["handled", "synthetic", "is_exception_group"])) item.mechanism = mechanism; const valuesOutput = list<PlainObject>(); append(valuesOutput, item); const output = record(); output.values = valuesOutput; return output; }); }
function event(value: unknown, transaction: boolean): PlainObject {
  const stack = new WeakSet<object>(); const built = guarded(value, stack, 0, (input) => { const output = record(); const id = ownData(input, "event_id"), time = ownData(input, "timestamp"), start = ownData(input, "start_timestamp"), level = ownData(input, "level"), platform = ownData(input, "platform"), release = ownData(input, "release"), environment = ownData(input, "environment"), rawMessage = ownData(input, "message"); const builtSdk = sdk(ownData(input, "sdk"), stack, 1), builtTags = tags(ownData(input, "tags"), stack, 1), builtContexts = contexts(ownData(input, "contexts"), stack, 1), builtBreadcrumbs = breadcrumbs(ownData(input, "breadcrumbs"), stack, 1), builtSpans = spans(ownData(input, "spans"), stack, 1); if (traceId(id)) output.event_id = id; if (timestamp(time)) output.timestamp = time; if (timestamp(start)) output.start_timestamp = start; if (valid(level, EVENT_LEVELS)) output.level = level; if (platform === "javascript") output.platform = platform; if (typeof release === "string" && (/^[a-f0-9]{40}$/.test(release) || release === "axis@0.1.0")) output.release = release; if (valid(environment, ENVIRONMENTS)) output.environment = environment; if (builtSdk) output.sdk = builtSdk; if (builtTags && nonempty(builtTags, ["area", "provider", "operation", "code", "route", "status", "outcome", "durationMs"])) output.tags = builtTags; if (builtContexts && nonempty(builtContexts, ["safe_fetch", "providerCall", "composio", "supabase", "trace"])) output.contexts = builtContexts; if (builtBreadcrumbs) output.breadcrumbs = builtBreadcrumbs; if (builtSpans) output.spans = builtSpans; if (transaction) { output.type = "transaction"; const info = ownData(input, "transaction_info"), raw = ownData(input, "transaction"), source = ownData(info, "source"); if (source === "route" && typeof raw === "string") { let canonical = route(raw) ? raw : undefined; for (const method of HTTP_METHODS) { if (!canonical && raw.startsWith(`${method} `)) { const candidate = raw.slice(method.length + 1); if (route(candidate)) canonical = candidate; } } if (canonical) { output.transaction = canonical; const transactionInfo = record(); transactionInfo.source = "route"; output.transaction_info = transactionInfo; } } } else { const builtException = exception(ownData(input, "exception"), stack, 1); if (builtException) output.exception = builtException; else if (rawMessage !== undefined) output.message = valid(rawMessage, AXIS_TELEMETRY_SETS.codes) ? rawMessage : "AXIS_REDACTED_EVENT"; } return output; }); return built ?? record();
}

export function scrubSentryEventStrict<T extends Event>(input: T): T { return event(input, false) as T; }
export function scrubSentryTransaction<T extends TransactionEvent>(input: T): T { return event(input, true) as T; }
export function scrubSentrySpan<T extends SpanJSON>(input: T): T { return span(input) as T; }
export function scrubSentryBreadcrumb<T extends Breadcrumb>(input: T): T { return breadcrumb(input) as T; }

/** Detects ambient serialization hooks without calling attacker-controlled code. */
export function hasSentryPrototypePollution(): boolean {
  try {
    return Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") !== undefined
      || Object.getOwnPropertyDescriptor(Array.prototype, "toJSON") !== undefined;
  } catch {
    return true;
  }
}

function minimalSpan(): SpanJSON {
  const output = record();
  output.trace_id = ZERO_TRACE_ID;
  output.span_id = ZERO_SPAN_ID;
  output.start_timestamp = 0;
  return output as unknown as SpanJSON;
}

/** Hook adapters fail closed under global serialization-hook pollution. */
export function guardedSentryEvent<T extends Event>(input: T): T | null { return hasSentryPrototypePollution() ? null : scrubSentryEventStrict(input); }
export function guardedSentryTransaction<T extends TransactionEvent>(input: T): T | null { return hasSentryPrototypePollution() ? null : scrubSentryTransaction(input); }
export function guardedSentryBreadcrumb<T extends Breadcrumb>(input: T): T | null { return hasSentryPrototypePollution() ? null : scrubSentryBreadcrumb(input); }
export function guardedSentrySpan<T extends SpanJSON>(input: T): T { return (hasSentryPrototypePollution() ? minimalSpan() : scrubSentrySpan(input)) as T; }
