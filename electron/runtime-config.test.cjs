/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCAL_DESKTOP_URL,
  PRODUCTION_DESKTOP_URL,
  normalizeDesktopUrl,
  parseSentryDsn,
  resolveRuntimeConfig,
} = require("./runtime-config.cjs");

test("development defaults to the local AXIS server", () => {
  const runtime = resolveRuntimeConfig({
    isPackaged: false,
    env: {},
    metadata: { version: "1.2.3", axisDesktop: { productionUrl: PRODUCTION_DESKTOP_URL } },
  });
  assert.equal(runtime.axisUrl, LOCAL_DESKTOP_URL);
  assert.equal(runtime.release, "axis-desktop@1.2.3");
});

test("packaged builds use immutable production metadata instead of a process override", () => {
  const runtime = resolveRuntimeConfig({
    isPackaged: true,
    env: { AXIS_DESKTOP_URL: "https://attacker.example" },
    metadata: { version: "1.2.3", axisDesktop: { productionUrl: PRODUCTION_DESKTOP_URL } },
  });
  assert.equal(runtime.axisUrl, PRODUCTION_DESKTOP_URL);
  assert.equal(runtime.axisOrigin, PRODUCTION_DESKTOP_URL);
});

test("production origin rejects insecure and local URLs", () => {
  assert.throws(() => normalizeDesktopUrl("http://example.com", { production: true }));
  assert.throws(() => normalizeDesktopUrl("https://localhost", { production: true }));
});

test("Sentry DSN produces public minidump and envelope ingestion URLs", () => {
  const sentry = parseSentryDsn("https://public-key@o123.ingest.sentry.io/456");
  assert.equal(
    sentry.minidumpUrl,
    "https://o123.ingest.sentry.io/api/456/minidump/?sentry_key=public-key",
  );
  assert.equal(
    sentry.envelopeUrl,
    "https://o123.ingest.sentry.io/api/456/envelope/?sentry_version=7&sentry_key=public-key",
  );
});
