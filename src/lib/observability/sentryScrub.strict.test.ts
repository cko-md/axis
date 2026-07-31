import { describe, expect, it, vi } from "vitest";
import { createEnvelope, serializeEnvelope, type TransactionEvent } from "@sentry/core";
import type { Breadcrumb, Event } from "@sentry/nextjs";

const producerSentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => producerSentry);

import { AXIS_ROUTE_MANIFEST } from "./axisRouteManifest";
import {
  scrubSentryBreadcrumb,
  scrubSentryEventStrict,
  scrubSentrySpan,
  scrubSentryTransaction,
  guardedSentryBreadcrumb,
  guardedSentryEvent,
  guardedSentrySpan,
  guardedSentryTransaction,
  hasSentryPrototypePollution,
} from "./sentryScrub";
import { SafeFetchError } from "../security/safe-fetch";
import { recordSafeFetchFailure } from "../security/safe-fetch-observability";
import { captureRouteError } from "./captureRouteError";
import { recordProviderFailure } from "./providerTiming";

const TRACE = "a".repeat(32);
const SPAN = "b".repeat(16);
const RELEASE = "c".repeat(40);
const canary = "https://private.example/a?token=must-not-leak#fragment";

function serialise(item: unknown, type: "event" | "transaction" = "event") {
  const envelope = serializeEnvelope(createEnvelope({}, [[{ type }, item] as never]));
  return typeof envelope === "string" ? envelope : new TextDecoder().decode(envelope);
}

function safeData(operation = "cached_feed", code = "SAFE_FETCH_TIMEOUT") {
  return { area: "safe-fetch", provider: "youtube", transport: "direct", operation, code };
}

describe("strict Sentry closed-world transport", () => {
  it("emits a fresh approved event and preserves only exact diagnostics", () => {
    const raw = {
      event_id: TRACE, timestamp: 123, level: "error", platform: "javascript", release: RELEASE, environment: "production",
      sdk: { name: "sentry.javascript.nextjs", version: "10.59.0", integrations: [canary] },
      tags: { ...safeData(), route: "/api/feeds/cached", url: canary },
      contexts: { ...safeData(), target: canary }, request: { url: canary }, user: { email: "a@b.test" },
      breadcrumbs: [{ category: "safe-fetch", level: "info", message: canary, data: { ...safeData(), href: canary } }],
      exception: { values: [{ type: canary, value: "SAFE_FETCH_TIMEOUT", stacktrace: { frames: [{ filename: canary }] } }] },
      extra: { canary }, fingerprint: [canary], modules: { canary },
    } as unknown as Event;
    const event = scrubSentryEventStrict(raw);
    expect(event).not.toBe(raw);
    expect(event).toMatchObject({ event_id: TRACE, release: RELEASE, sdk: { name: "sentry.javascript.nextjs", version: "10.59.0" }, tags: { operation: "cached_feed", route: "/api/feeds/cached" } });
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.exception?.values?.[0]).toEqual({ type: "Error", value: "SAFE_FETCH_TIMEOUT" });
    expect(event.breadcrumbs?.[0]?.message).toBeUndefined();
    expect(serialise(event)).not.toContain("must-not-leak");
  });

  it("uses fixed redacted exception/message values for unapproved strings", () => {
    const exception = scrubSentryEventStrict({ exception: { values: [{ value: canary, mechanism: { handled: false, synthetic: true, type: canary } }] } } as Event);
    const message = scrubSentryEventStrict({ message: canary } as Event);
    expect(exception.exception?.values?.[0]).toEqual({ type: "Error", value: "AXIS_REDACTED_ERROR", mechanism: { handled: false, synthetic: true } });
    expect(message.message).toBe("AXIS_REDACTED_EVENT");
  });

  it("requires exact identifiers, timestamps, release, environment and SDK pair", () => {
    const event = scrubSentryEventStrict({
      event_id: "A".repeat(32), timestamp: Infinity, level: "warn", platform: "node", release: "c".repeat(39), environment: "staging",
      sdk: { name: "sentry.javascript.nextjs", version: "10.60.0" },
    } as unknown as Event);
    expect(event).toEqual({});
  });

  it("covers every reviewed safe-fetch operation and code while dropping unknown metadata", () => {
    const operations = ["cached_feed", "briefing_feed", "reader_extract", "web_proxy", "og_image_meta", "og_image_resolve", "og_image_stream", "youtube_watch_page", "youtube_caption"];
    const codes = ["SAFE_FETCH_INVALID_URL", "SAFE_FETCH_BLOCKED_HOST", "SAFE_FETCH_DNS_FAILED", "SAFE_FETCH_BLOCKED_ADDRESS", "SAFE_FETCH_INVALID_REDIRECT", "SAFE_FETCH_TOO_MANY_REDIRECTS", "SAFE_FETCH_TIMEOUT", "SAFE_FETCH_BODY_TOO_LARGE", "SAFE_FETCH_ABORTED", "SAFE_FETCH_TRANSPORT_FAILED", "SAFE_FETCH_ROUTE_FAILED"];
    for (const operation of operations) for (const code of codes) {
      const event = scrubSentryEventStrict({ tags: { ...safeData(operation, code), unreviewed: canary } } as Event);
      expect(event.tags).toMatchObject({ operation, code });
      expect(event.tags).not.toHaveProperty("unreviewed");
    }
  });

  it("keeps exact Spotify, AI/provider, and entity codes actionable while dropping canaries and unknown codes", () => {
    const cases = [
      { area: "integrations", provider: "spotify", operation: "complete_oauth", codes: ["SPOTIFY_DENIED", "SPOTIFY_MISSING_CODE", "SPOTIFY_STATE_MISSING", "SPOTIFY_STATE_MISMATCH", "SPOTIFY_NOT_CONFIGURED", "SPOTIFY_TOKEN_EXCHANGE_FAILED"] },
      { area: "ai", provider: "ai", operation: "generate", codes: ["PROVIDER_RATE_LIMITED", "PROVIDER_ERROR", "PROVIDER_FALLBACK"] },
      { area: "workspace", provider: "supabase", operation: "references", codes: ["REFERENCES_UNAVAILABLE"] },
    ] as const;
    for (const { area, provider, operation, codes } of cases) for (const code of codes) {
      const output = scrubSentryEventStrict({ tags: { area, provider, operation, code, private_target: canary } } as Event);
      expect(output.tags).toMatchObject({ area, provider, operation, code });
      expect(JSON.stringify(output)).not.toContain("must-not-leak");
    }
    for (const provider of ["gemini", "anthropic"] as const) {
      const output = scrubSentryEventStrict({ tags: { area: "ai", provider, operation: "generate", code: "PROVIDER_ERROR", private_target: canary } } as Event);
      expect(output.tags).toMatchObject({ area: "ai", provider, operation: "generate", code: "PROVIDER_ERROR" });
      expect(JSON.stringify(output)).not.toContain("must-not-leak");
    }
    const unknown = scrubSentryEventStrict({ tags: { area: "ai", provider: "ai", operation: "generate", code: "UNREVIEWED_DYNAMIC_CODE", private_target: canary } } as Event);
    expect(unknown.tags).toMatchObject({ area: "ai", provider: "ai", operation: "generate" });
    expect(unknown.tags).not.toHaveProperty("code");
    expect(JSON.stringify(unknown)).not.toContain("must-not-leak");
  });

  it("allows every manifest route and rejects route-shaped adversarial variants", () => {
    for (const route of AXIS_ROUTE_MANIFEST) {
      const tx = scrubSentryTransaction({ type: "transaction", transaction: `GET ${route}`, transaction_info: { source: "route" } } as TransactionEvent);
      expect(tx.transaction).toBe(route);
    }
    for (const route of ["/api/feeds/concrete", "/api/feeds/cached?x=1", "/api/feeds/cached#x", "/api/feeds/%2fcached", "/api/feeds/../cached", "/api//feeds/cached", "\\api\\feeds\\cached", "https://axis.test/api/feeds/cached"]) {
      const tx = scrubSentryTransaction({ type: "transaction", transaction: `GET ${route}`, transaction_info: { source: "route" } } as TransactionEvent);
      expect(tx.transaction).toBeUndefined();
    }
  });

  it("accepts only route-source transactions and emits canonical bare routes", () => {
    const good = scrubSentryTransaction({ type: "transaction", transaction: "POST /api/feeds/cached", transaction_info: { source: "route" } } as TransactionEvent);
    const bad = scrubSentryTransaction({ type: "transaction", transaction: "GET /api/feeds/cached", transaction_info: { source: "url" } } as TransactionEvent);
    expect(good.transaction).toBe("/api/feeds/cached");
    expect(good.transaction_info).toEqual({ source: "route" });
    expect(bad.transaction).toBeUndefined();
  });

  it("handles getters, throwing descriptor proxies, exotic values and cycles without reading them", () => {
    let getterReads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "request", { get() { getterReads += 1; return { url: canary }; } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(canary); } });
    const cycle: Record<string, unknown> = { tags: safeData() }; cycle.self = cycle;
    const bigint = (globalThis as { BigInt?: (value: number) => bigint }).BigInt?.(1);
    for (const input of [hostile, proxy, { extra: new Map([[canary, canary]]), breadcrumbs: [Promise.resolve(canary)], tags: cycle, fn: () => canary, symbol: Symbol(canary), bigint }]) {
      expect(() => JSON.stringify(scrubSentryEventStrict(input as Event))).not.toThrow();
    }
    expect(getterReads).toBe(0);
  });

  it("drops every non-schema surface including serialization traps and supports frozen/null-prototype inputs", () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.operation = "cached_feed";
    nullPrototype.code = "SAFE_FETCH_TIMEOUT";
    const tags = Object.freeze(nullPrototype);
    const input = {
      tags, request: { url: canary }, user: { id: canary }, logentry: { message: canary }, logger: canary,
      server_name: canary, modules: { [canary]: canary }, dist: canary, fingerprint: [canary], measurements: { x: canary },
      debug_meta: { images: [canary] }, threads: { values: [canary] }, sdkProcessingMetadata: { canary }, profile: { canary },
      toJSON() { throw new Error(canary); }, __proto__: { canary }, constructor: { canary }, prototype: { canary },
    } as unknown as Event;
    const output = scrubSentryEventStrict(input);
    expect(output.tags).toEqual({ operation: "cached_feed", code: "SAFE_FETCH_TIMEOUT" });
    expect(() => JSON.stringify(output)).not.toThrow();
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
  });

  it("bounds arrays and emits fixed safe fallbacks for invalid spans", () => {
    const breadcrumbs = Array.from({ length: 101 }, () => ({ category: "safe-fetch", data: safeData() }));
    const spans = Array.from({ length: 1001 }, () => ({ trace_id: TRACE, span_id: SPAN, start_timestamp: 1, op: "cached_feed", data: safeData() }));
    const event = scrubSentryEventStrict({ breadcrumbs, spans } as Event);
    expect(event.breadcrumbs).toHaveLength(100);
    expect(event.spans).toHaveLength(1000);
    expect(scrubSentrySpan({ trace_id: "bad", span_id: "bad", start_timestamp: NaN } as unknown as import("@sentry/core").SpanJSON)).toMatchObject({ trace_id: "0".repeat(32), span_id: "0".repeat(16), start_timestamp: 0 });
  });

  it("keeps standalone and nested span/breadcrumb outputs equivalent", () => {
    const rawSpan = { trace_id: TRACE, span_id: SPAN, start_timestamp: 1, timestamp: 2, status: "ok", op: "cached_feed", data: { ...safeData(), "http.route": "/api/feeds/cached", url: canary } };
    const rawBreadcrumb = { category: "safe-fetch", level: "info", data: safeData(), message: canary };
    const event = scrubSentryEventStrict({ spans: [rawSpan], breadcrumbs: [rawBreadcrumb] } as Event);
    expect(event.spans?.[0]).toEqual(scrubSentrySpan(rawSpan));
    expect(event.breadcrumbs?.[0]).toEqual(scrubSentryBreadcrumb(rawBreadcrumb as Breadcrumb));
  });

  it("never leaks a canary through JSON or transaction envelope serialization", () => {
    const tx = scrubSentryTransaction({ type: "transaction", transaction: canary, request: { url: canary }, spans: [{ trace_id: TRACE, span_id: SPAN, start_timestamp: 1, data: { "http.url": canary } }] } as unknown as TransactionEvent);
    expect(() => JSON.stringify(tx)).not.toThrow();
    expect(() => serialise(tx, "transaction")).not.toThrow();
    expect(serialise(tx, "transaction")).not.toContain("must-not-leak");
  });

  it("accepts the actual safe-fetch producer's breadcrumb and capture tags", () => {
    producerSentry.addBreadcrumb.mockClear();
    producerSentry.captureException.mockClear();
    recordSafeFetchFailure("reader_extract", canary, new SafeFetchError("SAFE_FETCH_TIMEOUT"));
    const breadcrumb = producerSentry.addBreadcrumb.mock.calls[0]?.[0] as Breadcrumb;
    const captureContext = producerSentry.captureException.mock.calls[0]?.[1] as { tags: Record<string, unknown> };
    expect(scrubSentryBreadcrumb(breadcrumb)).toMatchObject({ category: "safe-fetch", data: { operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT" } });
    expect(scrubSentryEventStrict({ tags: captureContext.tags } as Event).tags).toMatchObject({ area: "safe-fetch", operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT" });
  });

  it("emits null-prototype records and arrays without inherited serialization hooks", () => {
    const objectPrototype = Object.prototype as Record<string, unknown>;
    const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
    const objectToJson = objectPrototype.toJSON;
    const arrayToJson = arrayPrototype.toJSON;
    let poisoned = 0;
    objectPrototype.toJSON = function poison() { poisoned += 1; throw new Error(canary); };
    arrayPrototype.toJSON = function poison() { poisoned += 1; throw new Error(canary); };
    try {
      const error = scrubSentryEventStrict({ exception: { values: [{ value: "SAFE_FETCH_TIMEOUT" }] }, breadcrumbs: [{ category: "safe-fetch", data: safeData() }] } as Event);
      const transaction = scrubSentryTransaction({ type: "transaction", transaction: "GET /api/feeds/cached", transaction_info: { source: "route" }, spans: [{ trace_id: TRACE, span_id: SPAN, start_timestamp: 1, data: { ...safeData(), "http.route": "/api/feeds/cached" } }] } as unknown as TransactionEvent);
      const standaloneSpan = scrubSentrySpan({ trace_id: TRACE, span_id: SPAN, start_timestamp: 1, data: safeData() });
      const standaloneBreadcrumb = scrubSentryBreadcrumb({ category: "safe-fetch", data: safeData() });
      for (const output of [error, transaction, standaloneSpan, standaloneBreadcrumb]) {
        expect(Object.getPrototypeOf(output)).toBeNull();
        expect(() => JSON.stringify(output)).not.toThrow();
      }
      expect(Array.isArray(error.breadcrumbs)).toBe(true);
      expect(Object.getPrototypeOf(error.breadcrumbs as unknown as object)).toBeNull();
      expect(Array.isArray(transaction.spans)).toBe(true);
      expect(Object.getPrototypeOf(transaction.spans as unknown as object)).toBeNull();
      const header = Object.create(null) as { event_id: string };
      header.event_id = TRACE;
      const itemHeader = Object.create(null) as { type: "event" | "transaction" };
      itemHeader.type = "event";
      const brandIterable = (array: unknown[]) => { Object.setPrototypeOf(array, null); Object.defineProperty(array, Symbol.iterator, { value: Array.prototype[Symbol.iterator] }); return array; };
      const item: unknown[] = brandIterable([itemHeader, error]);
      const items: unknown[] = [item];
      brandIterable(items);
      const envelope: unknown[] = [header, items];
      brandIterable(envelope);
      expect(() => serializeEnvelope(envelope as never)).not.toThrow();
      itemHeader.type = "transaction";
      const transactionItem: unknown[] = brandIterable([itemHeader, transaction]);
      const transactionItems: unknown[] = [transactionItem];
      brandIterable(transactionItems);
      const transactionEnvelope: unknown[] = [header, transactionItems];
      brandIterable(transactionEnvelope);
      expect(() => serializeEnvelope(transactionEnvelope as never)).not.toThrow();
      expect(poisoned).toBe(0);
    } finally {
      if (objectToJson === undefined) delete objectPrototype.toJSON; else objectPrototype.toJSON = objectToJson;
      if (arrayToJson === undefined) delete arrayPrototype.toJSON; else arrayPrototype.toJSON = arrayToJson;
    }
  });

  it("admits trace-only route data and exact bounded trace/span numeric fields", () => {
    const event = scrubSentryEventStrict({
      start_timestamp: 1,
      contexts: { trace: { trace_id: TRACE, span_id: SPAN, parent_span_id: "c".repeat(16), segment_id: "d".repeat(16), status: "ok", op: "http.server", exclusive_time: 2.5, data: { ...safeData(), "http.route": "/api/feeds/cached" }, links: [{ trace_id: TRACE, span_id: SPAN }] }, safe_fetch: { ...safeData(), "http.route": "/api/feeds/cached" } },
      breadcrumbs: [{ category: "safe-fetch", data: { ...safeData(), "http.route": "/api/feeds/cached" } }],
    } as Event);
    expect(event.start_timestamp).toBe(1);
    expect(event.contexts?.trace).toMatchObject({ op: "http.server", exclusive_time: 2.5, data: { "http.route": "/api/feeds/cached" } });
    expect((event.contexts?.safe_fetch as Record<string, unknown>)["http.route"]).toBeUndefined();
    expect((event.breadcrumbs?.[0]?.data as Record<string, unknown>)["http.route"]).toBeUndefined();
    const numeric = scrubSentryBreadcrumb({ category: "provider.retry", data: { ...safeData(), status: "503", durationMs: 2_678_400_000, delayMs: 1, attempt: 10, attempted: 1_000_000, response_body_size: 10_000_000, outcome: "slow" } });
    expect(numeric.data).toMatchObject({ status: 503, durationMs: 2_678_400_000, attempt: 10, outcome: "slow" });
  });

  it("keeps registered route-error and provider timing diagnostics actionable while dropping target/message data", () => {
    producerSentry.addBreadcrumb.mockClear();
    producerSentry.captureException.mockClear();
    captureRouteError(new Error(canary), { route: "/api/mail/inbox", area: "mail", provider: "gmail", operation: "list", status: 503, code: "SERVICE_UNAVAILABLE", tags: { target: canary, private_id: "secret" } });
    const routeBreadcrumb = producerSentry.addBreadcrumb.mock.calls[0]?.[0] as Breadcrumb;
    const routeCapture = producerSentry.captureException.mock.calls[0]?.[1] as { tags: Record<string, unknown> };
    expect(scrubSentryBreadcrumb(routeBreadcrumb).data).toMatchObject({ area: "mail", provider: "gmail", operation: "list", status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(scrubSentryEventStrict({ tags: routeCapture.tags } as Event).tags).toMatchObject({ area: "mail", provider: "gmail", operation: "list", status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(JSON.stringify(scrubSentryBreadcrumb(routeBreadcrumb))).not.toContain("private_id");
    producerSentry.addBreadcrumb.mockClear();
    producerSentry.captureException.mockClear();
    recordProviderFailure({ area: "fund", provider: "polygon", operation: "fetch_quote", captureFailures: true }, { code: "provider_error", status: 503, message: canary }, 123);
    const timingBreadcrumb = producerSentry.addBreadcrumb.mock.calls[0]?.[0] as Breadcrumb;
    const timingCapture = producerSentry.captureException.mock.calls[0]?.[1] as { tags: Record<string, unknown>; contexts: Record<string, unknown> };
    expect(scrubSentryBreadcrumb(timingBreadcrumb).data).toMatchObject({ area: "fund", provider: "polygon", operation: "fetch_quote", code: "provider_error", status: 503, durationMs: 123, outcome: "error" });
    const strictCapture = scrubSentryEventStrict({ tags: timingCapture.tags, contexts: timingCapture.contexts } as Event);
    expect(strictCapture.contexts?.providerCall).toMatchObject({ area: "fund", provider: "polygon", operation: "fetch_quote", code: "provider_error", status: 503, durationMs: 123, outcome: "error" });
    expect(JSON.stringify(strictCapture)).not.toContain("private.example");
  });

  it("reads each event message descriptor once and never accepts a later hostile value", () => {
    let reads = 0;
    const input = new Proxy({}, { getOwnPropertyDescriptor(_target, key) { if (key === "message") { reads += 1; return { configurable: true, enumerable: true, value: reads === 1 ? "SAFE_FETCH_TIMEOUT" : canary }; } return undefined; } });
    const output = scrubSentryEventStrict(input as Event);
    expect(reads).toBe(1);
    expect(output.message).toBe("SAFE_FETCH_TIMEOUT");
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
  });

  it("chooses registered aliases after invalid primaries using one descriptor read per candidate", () => {
    const counts = new Map<string, number>();
    const input = new Proxy({}, { getOwnPropertyDescriptor(_target, key) { const name = String(key); counts.set(name, (counts.get(name) ?? 0) + 1); const values: Record<string, unknown> = { operation: "not-registered", op: "fetch_quote", code: "not-registered", error_code: "provider_error", supabase_code: "RPC_FAILED", status: "not-a-status", http_status: "503", status_code: "500", "http.status_code": "502" }; return name in values ? { configurable: true, enumerable: true, value: values[name] } : undefined; } });
    const output = scrubSentryBreadcrumb({ category: "provider.failure", data: input });
    expect(output.data).toMatchObject({ operation: "fetch_quote", code: "provider_error", status: 503 });
    for (const key of ["operation", "op", "code", "error_code", "supabase_code", "status", "http_status", "status_code", "http.status_code"]) expect(counts.get(key)).toBe(1);
  });

  it.each(["gmail", "outlook"] as const)("keeps the %s Mail provider send/reply matrix actionable", (provider) => {
    for (const operation of ["send", "reply"] as const) {
      const output = scrubSentryBreadcrumb({ category: "provider.failure", data: { area: "mail", provider, operation, code: "provider_error", status: "503" } });
      expect(output.data).toMatchObject({ area: "mail", provider, operation, code: "provider_error", status: 503 });
    }
  });

  it("accepts registered late-producer aliases while dropping their private metadata", () => {
    for (const operation of ["install", "remove", "add", "manage_signal", "triage_signal", "route_signal", "scan_platform", "capture_signal", "delete_signal", "persist_reconciliation_state", "list_connections", "read_cache", "transcribe_audio", "quick"] as const) {
      const output = scrubSentryBreadcrumb({ category: "route.error", data: { operation: "invalid", op: operation, error_code: "outbox_encryption_unavailable", secret: canary } });
      expect(output.data).toMatchObject({ operation, code: "outbox_encryption_unavailable" });
      expect(JSON.stringify(output)).not.toContain("must-not-leak");
    }
    for (const code of ["ENCODE_FAILED", "PANE_LIMIT"] as const) expect(scrubSentryBreadcrumb({ category: "route.error", data: { code } }).data).toMatchObject({ code });
  });

  it("fails closed before event, transaction, and breadcrumb transport under poisoned prototypes", () => {
    const objectPrototype = Object.prototype as Record<string, unknown>;
    const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
    objectPrototype.toJSON = () => canary;
    try {
      expect(hasSentryPrototypePollution()).toBe(true);
      expect(guardedSentryEvent({ message: "SAFE_FETCH_TIMEOUT" } as Event)).toBeNull();
      expect(guardedSentryTransaction({ type: "transaction" } as TransactionEvent)).toBeNull();
      expect(guardedSentryBreadcrumb({ category: "safe-fetch" })).toBeNull();
      const fallback = guardedSentrySpan({ trace_id: TRACE, span_id: SPAN, start_timestamp: 1 } as import("@sentry/core").SpanJSON);
      expect(Object.getPrototypeOf(fallback)).toBeNull();
      expect(fallback).toMatchObject({ trace_id: "0".repeat(32), span_id: "0".repeat(16), start_timestamp: 0 });
    } finally { delete objectPrototype.toJSON; }
    arrayPrototype.toJSON = () => canary;
    try {
      expect(hasSentryPrototypePollution()).toBe(true);
      expect(guardedSentryEvent({ message: "SAFE_FETCH_TIMEOUT" } as Event)).toBeNull();
    } finally { delete arrayPrototype.toJSON; }
  });
});
