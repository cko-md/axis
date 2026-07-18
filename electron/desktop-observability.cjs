/* eslint-disable @typescript-eslint/no-require-imports */
const { randomUUID } = require("node:crypto");

const PRIVATE_URL = /\bhttps?:\/\/[^\s)]+/gi;
const PRIVATE_PATH = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s:]+/gi;

function sanitizeMessage(value) {
  return String(value || "Desktop error")
    .replace(PRIVATE_URL, "[url]")
    .replace(PRIVATE_PATH, "[local-path]")
    .slice(0, 500);
}

function safeTags(tags = {}) {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [String(key).slice(0, 32), String(value).slice(0, 120)]),
  );
}

function buildSentryEnvelope({ sentry, release, environment, error, tags }) {
  const eventId = randomUUID().replaceAll("-", "");
  const timestamp = new Date().toISOString();
  const errorName = error instanceof Error ? error.name : "Error";
  const errorMessage = error instanceof Error ? error.message : error;
  const event = {
    event_id: eventId,
    timestamp,
    platform: "node",
    level: "error",
    logger: "axis.desktop",
    release,
    environment,
    tags: safeTags(tags),
    exception: {
      values: [{
        type: sanitizeMessage(errorName),
        value: sanitizeMessage(errorMessage),
      }],
    },
  };
  return [
    JSON.stringify({ event_id: eventId, sent_at: timestamp, dsn: sentry.publicDsn }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
}

function createDesktopObservability({ crashReporter, runtime, fetchImpl = globalThis.fetch }) {
  const report = (error, tags) => {
    if (!runtime.sentry || typeof fetchImpl !== "function") return;
    const envelope = buildSentryEnvelope({
      sentry: runtime.sentry,
      release: runtime.release,
      environment: runtime.environment,
      error,
      tags,
    });
    void fetchImpl(runtime.sentry.envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
    }).catch(() => {
      // Reporting must never become a second application failure.
    });
  };

  const crashOptions = {
    companyName: "AXIS",
    productName: "AXIS Desktop",
    uploadToServer: Boolean(runtime.sentry),
    compress: true,
    rateLimit: true,
    globalExtra: {
      environment: runtime.environment,
      release: runtime.release,
    },
  };
  if (runtime.sentry) crashOptions.submitURL = runtime.sentry.minidumpUrl;
  crashReporter.start(crashOptions);

  process.on("uncaughtExceptionMonitor", (error) => report(error, { operation: "uncaught-exception" }));
  process.on("unhandledRejection", (reason) => report(reason, { operation: "unhandled-rejection" }));

  return {
    captureException: report,
    captureMessage(message, tags) {
      report(new Error(message), tags);
    },
    uploadsEnabled: Boolean(runtime.sentry),
  };
}

module.exports = {
  buildSentryEnvelope,
  createDesktopObservability,
  sanitizeMessage,
};
