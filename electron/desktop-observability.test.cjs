/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSentryEnvelope, createDesktopObservability, sanitizeMessage } = require("./desktop-observability.cjs");
const { parseSentryDsn } = require("./runtime-config.cjs");

test("desktop telemetry scrubs URLs and local user paths", () => {
  const message = sanitizeMessage("Failed at https://private.example/path for /Users/alice/private/file");
  assert.equal(message, "Failed at [url] for [local-path]");
});

test("desktop telemetry configures native minidumps and sends a scrubbed Sentry envelope", () => {
  const starts = [];
  const requests = [];
  const runtime = {
    environment: "production",
    release: "axis-desktop@1.2.3",
    sentry: parseSentryDsn("https://public-key@o123.ingest.sentry.io/456"),
  };
  const telemetry = createDesktopObservability({
    crashReporter: { start: (options) => starts.push(options) },
    runtime,
    fetchImpl: (url, options) => {
      requests.push({ url, options });
      return Promise.resolve({ ok: true });
    },
  });

  telemetry.captureException(
    new Error("Failed https://private.example/account at /Users/alice/private"),
    { operation: "test", ignoredObject: { private: true } },
  );

  assert.equal(starts[0].uploadToServer, true);
  assert.equal(starts[0].submitURL, runtime.sentry.minidumpUrl);
  assert.equal(requests[0].url, runtime.sentry.envelopeUrl);
  assert.doesNotMatch(requests[0].options.body, /private\.example|alice/);
  assert.match(requests[0].options.body, /axis\.desktop/);
});

test("Sentry envelopes contain only safe scalar tags", () => {
  const sentry = parseSentryDsn("https://public-key@o123.ingest.sentry.io/456");
  const envelope = buildSentryEnvelope({
    sentry,
    release: "axis-desktop@1.2.3",
    environment: "production",
    error: new Error("boom"),
    tags: { operation: "reader", nested: { secret: true } },
  });
  const event = JSON.parse(envelope.split("\n")[2]);
  assert.deepEqual(event.tags, { operation: "reader" });
});
