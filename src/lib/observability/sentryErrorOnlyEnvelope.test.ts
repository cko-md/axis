import {
  createEnvelope,
  createEventEnvelopeHeaders,
  createTransport,
  makeDsn,
  serializeEnvelope,
  type Envelope,
  type Event,
  type TransportRequest,
} from "@sentry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAxisErrorOnlyEnvelopeFinalizer } from "./sentryErrorOnlyEnvelope";

const DSN = "https://abc123@o1.ingest.sentry.io/42";
const PRIVATE_DSN = "https://public:private@o1.ingest.sentry.io/42";
const PUBLIC_DSN = "https://public@o1.ingest.sentry.io/42";
const EVENT_ID = "a".repeat(32);
const CANARY = "https://private.example/?token=must-not-leak";

function event(overrides: Partial<Event> = {}): Event {
  return {
    event_id: EVENT_ID,
    release: "c".repeat(40),
    environment: "preview",
    tags: { area: "mail", provider: "gmail", operation: "list", code: "SERVICE_UNAVAILABLE", private_target: CANARY },
    exception: { values: [{ value: "SERVICE_UNAVAILABLE", stacktrace: { frames: [{ filename: CANARY }] } }] },
    ...overrides,
  };
}

function envelope(
  itemType = "event",
  payload: unknown = event(),
  header: Record<string, unknown> = {},
): Envelope {
  return createEnvelope(
    {
      event_id: EVENT_ID,
      sent_at: "2026-07-31T01:02:03.004Z",
      dsn: DSN,
      sdk: { name: "sentry.javascript.nextjs", version: "10.59.0" },
      trace: { trace_id: CANARY },
      ...header,
    },
    [[{ type: itemType }, payload] as never],
  );
}

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).toJSON;
  delete (Array.prototype as unknown as Record<string, unknown>).toJSON;
});

describe("terminal error-only Sentry envelope", () => {
  it("accepts the installed core 10.59 tunneled and direct event-envelope header contracts", () => {
    const parsedDsn = makeDsn(PRIVATE_DSN);
    if (!parsedDsn) throw new Error("test DSN must parse");
    const sdkInfo = { name: "sentry.javascript.nextjs", version: "10.59.0" };
    const tunneledEvent = event();
    const directEvent = event();
    const tunneledHeader = createEventEnvelopeHeaders(
      tunneledEvent,
      sdkInfo,
      "/monitoring",
      parsedDsn,
    );
    const directHeader = createEventEnvelopeHeaders(
      directEvent,
      sdkInfo,
      undefined,
      parsedDsn,
    );

    expect(tunneledHeader.event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(directHeader.event_id).toMatch(/^[a-f0-9]{32}$/);
    expect((tunneledHeader as Record<string, unknown>).dsn).toBe(PUBLIC_DSN);
    expect(directHeader).not.toHaveProperty("dsn");
    expect(JSON.stringify(tunneledHeader)).not.toContain("private");
    expect(JSON.stringify(tunneledHeader)).not.toContain(PRIVATE_DSN);
    for (const header of [tunneledHeader, directHeader]) {
      expect(header.sent_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(new Date(header.sent_at).toISOString()).toBe(header.sent_at);
    }

    const contracts = [
      {
        envelope: createEnvelope(
          tunneledHeader,
          [[{ type: "event" }, tunneledEvent] as never],
        ),
        expectTunnel: true,
      },
      {
        envelope: createEnvelope(
          directHeader,
          [[{ type: "event" }, directEvent] as never],
        ),
        expectTunnel: false,
      },
    ];
    for (const contract of contracts) {
      makeAxisErrorOnlyEnvelopeFinalizer(PRIVATE_DSN, contract.expectTunnel)(contract.envelope);
      expect(contract.envelope[1]).toHaveLength(1);
      expect(typeof contract.envelope[1][0][1]).toBe("string");
      if (contract.expectTunnel) {
        expect((contract.envelope[0] as Record<string, unknown>).dsn).toBe(PUBLIC_DSN);
      } else {
        expect(contract.envelope[0]).not.toHaveProperty("dsn");
      }
      expect(JSON.stringify(contract.envelope[0])).not.toContain("private");
      expect(JSON.stringify(contract.envelope[0])).not.toContain(PRIVATE_DSN);
      const serialized = serializeEnvelope(contract.envelope);
      expect(serialized).not.toContain("must-not-leak");
      expect(serialized).not.toContain("private");
      expect(serialized).not.toContain(PRIVATE_DSN);
    }
  });

  it("accepts a real ordinary SDK envelope, strips arbitrary headers, and pre-serializes the event", () => {
    const value = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    expect(Object.getPrototypeOf(value[0])).toBeNull();
    expect(value[0]).toEqual({ event_id: EVENT_ID, sent_at: "2026-07-31T01:02:03.004Z", dsn: DSN });
    expect(value[0]).not.toHaveProperty("sdk");
    expect(value[0]).not.toHaveProperty("trace");
    expect(value[1]).toHaveLength(1);
    expect(Object.getPrototypeOf(value[1][0][0])).toBeNull();
    expect(value[1][0][0]).toEqual({ type: "event" });
    expect(typeof value[1][0][1]).toBe("string");
    expect(value[1][0][1]).toContain('"release":"cccccccccccccccccccccccccccccccccccccccc"');
    expect(value[1][0][1]).not.toContain("must-not-leak");
  });

  it("pins stock serializeEnvelope string-payload behavior after later prototype pollution", () => {
    const value = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    (Object.prototype as Record<string, unknown>).toJSON = () => CANARY;
    (Array.prototype as unknown as Record<string, unknown>).toJSON = () => CANARY;
    const serialized = serializeEnvelope(value);
    expect(serialized).toContain(`\n{"type":"event"}\n{"event_id":"${EVENT_ID}"`);
    expect(serialized).not.toContain("must-not-leak");
  });

  it("pins the real core transport executor boundary after finalization and later pollution", async () => {
    const value = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    (Object.prototype as Record<string, unknown>).toJSON = () => CANARY;
    (Array.prototype as unknown as Record<string, unknown>).toJSON = () => CANARY;
    const executor = vi.fn(async (request: TransportRequest) => {
      void request;
      return { statusCode: 200 };
    });
    const transport = createTransport({ recordDroppedEvent: vi.fn() }, executor);
    await transport.send(value);
    expect(executor).toHaveBeenCalledTimes(1);
    const body = executor.mock.calls[0]?.[0].body;
    const serialized = typeof body === "string" ? body : new TextDecoder().decode(body);
    expect(serialized).toContain(`\n{"type":"event"}\n{"event_id":"${EVENT_ID}"`);
    expect(serialized).not.toContain("must-not-leak");
  });

  it("does not invoke the real core transport executor for a fail-closed empty envelope", async () => {
    const value = envelope("transaction");
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    const executor = vi.fn(async (request: TransportRequest) => {
      void request;
      return { statusCode: 200 };
    });
    const transport = createTransport({ recordDroppedEvent: vi.fn() }, executor);
    await transport.send(value);
    expect(value[1]).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
  });

  it("drops queued pollution between the event hook and terminal envelope finalization", async () => {
    const value = envelope();
    queueMicrotask(() => {
      (Object.prototype as Record<string, unknown>).toJSON = () => CANARY;
    });
    await Promise.resolve();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    expect(value[1]).toEqual([]);
  });

  it("drops pollution installed by a descriptor trap during terminal re-scrub", () => {
    const payload = new Proxy(event(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "tags") (Object.prototype as Record<string, unknown>).toJSON = () => CANARY;
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    const value = envelope("event", payload);
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    expect(value[1]).toEqual([]);
  });

  it("pre-serializes safely when a descriptor trap queues pollution for the deferred transport drain", async () => {
    const payload = new Proxy(event(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "timestamp") {
          queueMicrotask(() => {
            (Object.prototype as Record<string, unknown>).toJSON = () => CANARY;
          });
        }
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    const value = envelope("event", payload);
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    expect(value[1]).toHaveLength(1);
    await Promise.resolve();
    expect(serializeEnvelope(value)).not.toContain("must-not-leak");
  });

  it.each([
    "transaction", "attachment", "session", "sessions", "client_report", "span",
    "log", "metric", "replay_event", "replay_recording", "profile", "profile_chunk",
  ])("drops unsupported %s items", (type) => {
    const value = envelope(type);
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
    expect(value[1]).toEqual([]);
  });

  it("drops multi-item and mismatched event-id envelopes", () => {
    const multiple = envelope();
    multiple[1].push([{ type: "event" }, event()] as never);
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(multiple);
    expect(multiple[1]).toEqual([]);
    const mismatch = envelope("event", event({ event_id: "b".repeat(32) }));
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(mismatch);
    expect(mismatch[1]).toEqual([]);
  });

  it("requires exact tunnel DSN and strict sent_at, while direct mode requires DSN omission", () => {
    for (const value of [
      envelope("event", event(), { dsn: "https://other@o1.ingest.sentry.io/42" }),
      envelope("event", event(), { dsn: undefined }),
      envelope("event", event(), { sent_at: undefined }),
      envelope("event", event(), { sent_at: "2026-07-31" }),
      envelope("event", event(), { sent_at: "2026-99-31T01:02:03.004Z" }),
    ]) {
      makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(value);
      expect(value[1]).toEqual([]);
    }
    const direct = envelope("event", event(), { dsn: undefined });
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, false)(direct);
    expect(direct[1]).toHaveLength(1);
    expect(direct[0]).not.toHaveProperty("dsn");
    const directWithDsn = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, false)(directWithDsn);
    expect(directWithDsn[1]).toEqual([]);
  });

  it("fails closed when configured DSN is missing or either ambient prototype is polluted", () => {
    const missing = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(undefined, true)(missing);
    expect(missing[1]).toEqual([]);
    const missingDirect = envelope("event", event(), { dsn: undefined });
    makeAxisErrorOnlyEnvelopeFinalizer(undefined, false)(missingDirect);
    expect(missingDirect[1]).toEqual([]);
    (Object.prototype as Record<string, unknown>).toJSON = () => CANARY;
    const dirtyObject = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(dirtyObject);
    expect(dirtyObject[1]).toEqual([]);
    delete (Object.prototype as Record<string, unknown>).toJSON;
    (Array.prototype as unknown as Record<string, unknown>).toJSON = () => CANARY;
    const dirtyArray = envelope();
    makeAxisErrorOnlyEnvelopeFinalizer(DSN, true)(dirtyArray);
    expect(dirtyArray[1]).toEqual([]);
  });
});
