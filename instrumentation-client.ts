import * as Sentry from "@sentry/nextjs";
import { scrubReplayRecordingEvent, scrubSentryBreadcrumb, scrubSentryEvent, scrubSentrySpan, scrubSentryTransaction } from "@/lib/observability/sentryScrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0.2,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.05,

  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
      // Replays must not serialize outbound network targets, credentials, or
      // request/response bodies. Trace hooks cover event envelopes separately.
      networkDetailAllowUrls: [],
      networkDetailDenyUrls: [/.*/],
      networkCaptureBodies: false,
      networkRequestHeaders: [],
      networkResponseHeaders: [],
      beforeAddRecordingEvent: scrubReplayRecordingEvent,
    }),
  ],

  // Disable in dev unless DSN is explicitly set
  enabled: process.env.NODE_ENV === "production" || !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryTransaction,
  beforeSendSpan: scrubSentrySpan,
  beforeBreadcrumb: scrubSentryBreadcrumb,
  sendDefaultPii: false,
  debug: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
