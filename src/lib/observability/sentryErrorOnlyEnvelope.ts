import { dsnToString, makeDsn, type Envelope, type Event } from "@sentry/core";
import { hasSentryPrototypePollution, scrubSentryEventStrict } from "./sentryScrub";

type MutableEnvelope = [unknown, unknown[]];
type EnvelopeFinalizer = (envelope: Envelope) => void;

const AXIS_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const AXIS_OBJECT_CREATE = Object.create;
const AXIS_JSON_STRINGIFY = JSON.stringify;
const AXIS_ARRAY_IS_ARRAY = Array.isArray;
const AXIS_DATE = Date;
const AXIS_DATE_PARSE = Date.parse;
const AXIS_DATE_TO_ISO = Date.prototype.toISOString;
const AXIS_NUMBER_IS_FINITE = Number.isFinite;
const EVENT_ID_RE = /^[a-f0-9]{32}$/;
const SENT_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function ownData(input: unknown, key: string): unknown {
  if ((typeof input !== "object" || input === null) && typeof input !== "function") return undefined;
  try {
    const descriptor = AXIS_GET_OWN_PROPERTY_DESCRIPTOR(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exactArrayLength(input: unknown, expected: number): input is unknown[] {
  if (!AXIS_ARRAY_IS_ARRAY(input)) return false;
  const length = ownData(input, "length");
  return length === expected;
}

function eventId(input: unknown): input is string {
  return typeof input === "string" && EVENT_ID_RE.test(input);
}

function strictSentAt(input: unknown): input is string {
  if (typeof input !== "string" || input.length !== 24 || !SENT_AT_RE.test(input)) return false;
  const milliseconds = AXIS_DATE_PARSE(input);
  return AXIS_NUMBER_IS_FINITE(milliseconds)
    && AXIS_DATE_TO_ISO.call(new AXIS_DATE(milliseconds)) === input;
}

function record(): Record<string, unknown> {
  return AXIS_OBJECT_CREATE(null) as Record<string, unknown>;
}

function emptyEnvelope(envelope: MutableEnvelope): void {
  envelope[1] = [];
}

/**
 * Terminal error-only Sentry envelope finalizer.
 *
 * It is registered on the client immediately after init. Unsupported or dirty
 * envelopes are emptied. Valid error events are re-scrubbed, synchronously
 * serialized with the pristine JSON intrinsic, and rebuilt from safe headers.
 * A later Edge transport drain therefore never serializes a live event object.
 */
export function makeAxisErrorOnlyEnvelopeFinalizer(
  configuredDsn: string | undefined,
  expectTunnel: boolean,
): EnvelopeFinalizer {
  const parsedDsn = configuredDsn ? makeDsn(configuredDsn) : undefined;
  const expectedDsn = parsedDsn ? dsnToString(parsedDsn) : undefined;

  return (rawEnvelope: Envelope): void => {
    const envelope = rawEnvelope as unknown as MutableEnvelope;
    try {
      if (hasSentryPrototypePollution()) {
        emptyEnvelope(envelope);
        return;
      }
      const header = ownData(envelope, "0");
      const items = ownData(envelope, "1");
      if (!header || !exactArrayLength(items, 1)) {
        emptyEnvelope(envelope);
        return;
      }
      const item = ownData(items, "0");
      if (!exactArrayLength(item, 2)) {
        emptyEnvelope(envelope);
        return;
      }
      const itemHeader = ownData(item, "0");
      const payload = ownData(item, "1");
      if (ownData(itemHeader, "type") !== "event") {
        emptyEnvelope(envelope);
        return;
      }

      const headerEventId = ownData(header, "event_id");
      const payloadEventId = ownData(payload, "event_id");
      const sentAt = ownData(header, "sent_at");
      const envelopeDsn = ownData(header, "dsn");
      if (!eventId(headerEventId) || payloadEventId !== headerEventId) {
        emptyEnvelope(envelope);
        return;
      }
      if (!strictSentAt(sentAt)) {
        emptyEnvelope(envelope);
        return;
      }
      if (
        !expectedDsn
        || (expectTunnel ? envelopeDsn !== expectedDsn : envelopeDsn !== undefined)
      ) {
        emptyEnvelope(envelope);
        return;
      }

      const safeEvent = scrubSentryEventStrict(payload as Event);
      if (ownData(safeEvent, "event_id") !== headerEventId || hasSentryPrototypePollution()) {
        emptyEnvelope(envelope);
        return;
      }
      const serializedEvent = AXIS_JSON_STRINGIFY(safeEvent);
      if (typeof serializedEvent !== "string" || hasSentryPrototypePollution()) {
        emptyEnvelope(envelope);
        return;
      }

      const safeEnvelopeHeader = record();
      safeEnvelopeHeader.event_id = headerEventId;
      safeEnvelopeHeader.sent_at = sentAt;
      if (expectTunnel) safeEnvelopeHeader.dsn = expectedDsn;
      const safeItemHeader = record();
      safeItemHeader.type = "event";

      envelope[0] = safeEnvelopeHeader;
      envelope[1] = [[safeItemHeader, serializedEvent]];
    } catch {
      emptyEnvelope(envelope);
    }
  };
}
