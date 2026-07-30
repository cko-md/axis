import * as Sentry from "@sentry/nextjs";
import { scrubSentryBreadcrumb, scrubSentryEventStrict, scrubSentrySpan, scrubSentryTransaction } from "@/lib/observability/sentryScrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0.2,
  // rrweb DOM/meta events can contain full href/src/window.location values.
  // Keep Replay completely disabled until every frame type has a proven scrubber.
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,

  // Disable in dev unless DSN is explicitly set
  enabled: process.env.NODE_ENV === "production" || !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend: scrubSentryEventStrict,
  beforeSendTransaction: scrubSentryTransaction,
  beforeSendSpan: scrubSentrySpan,
  beforeBreadcrumb: scrubSentryBreadcrumb,
  sendDefaultPii: false,
  debug: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
