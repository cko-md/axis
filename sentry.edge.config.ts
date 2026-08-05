import * as Sentry from "@sentry/nextjs";
import { filterAxisErrorOnlyIntegrations } from "@/lib/observability/sentryErrorOnlyConfig";
import { makeAxisErrorOnlyEnvelopeFinalizer } from "@/lib/observability/sentryErrorOnlyEnvelope";
import { guardedSentryBreadcrumb, guardedSentryEvent, guardedSentryTransaction } from "@/lib/observability/sentryScrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0,
  sendClientReports: false,
  enableLogs: false,
  enableMetrics: false,
  integrations: filterAxisErrorOnlyIntegrations,

  enabled: process.env.NODE_ENV === "production" || !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend: guardedSentryEvent,
  beforeSendTransaction: guardedSentryTransaction,
  beforeBreadcrumb: guardedSentryBreadcrumb,
  sendDefaultPii: false,
  debug: false,
});

Sentry.getClient()?.on(
  "beforeEnvelope",
  makeAxisErrorOnlyEnvelopeFinalizer(process.env.NEXT_PUBLIC_SENTRY_DSN, false),
);
