import * as Sentry from "@sentry/nextjs";
import { filterAxisErrorOnlyIntegrations } from "@/lib/observability/sentryErrorOnlyConfig";
import { makeAxisErrorOnlyEnvelopeFinalizer } from "@/lib/observability/sentryErrorOnlyEnvelope";
import { guardedSentryBreadcrumb, guardedSentryEvent, guardedSentryTransaction } from "@/lib/observability/sentryScrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

  tracesSampleRate: 0,
  sendClientReports: false,
  enableLogs: false,
  enableMetrics: false,
  integrations: filterAxisErrorOnlyIntegrations,
  // rrweb DOM/meta events can contain full href/src/window.location values.
  // Keep Replay completely disabled until every frame type has a proven scrubber.
  replaysOnErrorSampleRate: 0,
  replaysSessionSampleRate: 0,

  // Disable in dev unless DSN is explicitly set
  enabled: process.env.NODE_ENV === "production" || !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  beforeSend: guardedSentryEvent,
  beforeSendTransaction: guardedSentryTransaction,
  beforeBreadcrumb: guardedSentryBreadcrumb,
  sendDefaultPii: false,
  debug: false,
});

Sentry.getClient()?.on(
  "beforeEnvelope",
  makeAxisErrorOnlyEnvelopeFinalizer(process.env.NEXT_PUBLIC_SENTRY_DSN, true),
);

/**
 * Next.js/Sentry's build plugin requires this symbol to suppress its navigation
 * instrumentation warning. AXIS tracing is disabled, so it is intentionally a
 * typed no-op rather than delegating to Sentry's tracing helper.
 */
export function onRouterTransitionStart(
  href: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  void href;
  void navigationType;
}
