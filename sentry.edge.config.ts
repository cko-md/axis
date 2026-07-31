import * as Sentry from "@sentry/nextjs";
import { guardedSentryBreadcrumb, guardedSentryEvent, guardedSentrySpan, guardedSentryTransaction } from "@/lib/observability/sentryScrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0.2,
  traceLifecycle: "static",

  enabled: process.env.NODE_ENV === "production" || !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend: guardedSentryEvent,
  beforeSendTransaction: guardedSentryTransaction,
  beforeSendSpan: guardedSentrySpan,
  beforeBreadcrumb: guardedSentryBreadcrumb,
  sendDefaultPii: false,
  debug: false,
});
