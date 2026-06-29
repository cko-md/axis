# KEV-25 Latency Audit

Issue: KEV-25 - Latency: cache-first and partial-failure pass for Mail Console Schedule and Fund

Date: 2026-06-28
Follow-up: 2026-06-29

## Scope

This pass intentionally avoided schema changes and large cache migrations. The goal was to harden the current live-read paths with low-risk P0/P1 fixes:

- Provider call timeouts where missing.
- Partial data instead of blanking pages.
- Visible stale/error states when a refresh fails.
- Avoid full-screen loading when prior data exists.
- Route timing logs with safe metadata.
- Sentry breadcrumbs/errors for slow or failed provider calls without tokens, bodies, OAuth payloads, or private content.

## Surfaces Inspected

- Mail API: `src/app/api/mail/*`
- Console widgets API: `src/app/api/widgets/*`
- Massive/Polygon API: `src/app/api/massive/*`
- Schedule/calendar API: `src/app/api/calendar/*`
- Widget hook: `src/lib/hooks/useWidgetData.ts`
- Mail UI/hook-equivalent state: `src/components/mail/MailModule.tsx`
- Schedule UI/hook-equivalent state: `src/components/schedule/ScheduleModule.tsx`
- Fund hooks/UI: `src/lib/fund/usePlaidConnection.ts`, `src/components/fund/*`

## Current Behavior Before This Pass

- Mail inbox skipped failing accounts server-side, but had no per-account timeout and returned no structured partial state for the client.
- Mail detail and send/reply had no provider timeout; client failures could stop at a spinner or silent no-op.
- Console widget refresh replaced prior values with a loading glyph, even for background refreshes.
- Weather/AQI widget fallback values looked like plausible live data.
- Calendar external events silently collapsed provider failures to empty arrays.
- Calendar sync/conflict/delete failures were swallowed after local save/delete.
- Massive/Polygon and Plaid live calls had no shared timeout/timing metadata.
- Fund market/cashflow/spending views had several all-or-nothing refresh paths.

## Changes Made

- Added `src/lib/observability/providerTiming.ts` for provider timeouts, slow-call breadcrumbs, sanitized Sentry captures, and safe route timing logs.
- Added per-account Mail inbox timeouts and returned `partial`, `errors`, and `fetchedAt`.
- Added Mail detail/send timeouts and visible client toasts on failures.
- Updated Console widget fetching to preserve previous values during refresh and mark stale/error states.
- Added timeouts and route timing to weather, daylight, AQI, art, training, markets, Massive/Polygon, Plaid, and Strava paths.
- Replaced fake weather/AQI fallback readings with explicit unavailable states.
- Updated Schedule external calendar reads, sync, conflict checks, and cleanup to return/display partial failure states.
- Updated Fund market movers/news, cashflow, spending, sparklines, and Plaid balance status to preserve partial data and surface refresh failures.

## 2026-06-29 Follow-up

This follow-up kept the same low-risk/no-migration scope and closed remaining
timeout/observability gaps found after PR #28:

- Mail mutation actions (`mark-read`, `mark-unread`, `archive`, `delete`) now
  use `timedProviderOperation`, route timing logs, and safe Sentry metadata.
- Public.com brokerage read routes (`accounts`, `order-history`, `positions`)
  and the disabled live-order scaffold now use `timedProviderFetch` instead of
  raw provider `fetch`, with route timing and without logging upstream response
  bodies.
- Plaid background transaction sync and finance-daily balance reads now use
  `timedProviderFetch`, so slow Plaid calls time out and emit provider
  breadcrumbs/errors instead of hanging cron/webhook work.
- The shared Fund Plaid client hook now applies client-side request timeouts for
  status, balance, link-token, and exchange calls. Existing balances are
  preserved on refresh failure and Link startup failures show a visible toast.

Still intentionally deferred:

- Persistent cache tables and cache-first migrations.
- Background queue/retry workers.
- A wider Public.com provider abstraction.

## Deferred Work

- No Supabase cache tables or sync-state migrations were added. Full cache-first Mail/Calendar/Console architecture still belongs in a dedicated data-layer issue.
- No queue/background sync worker was introduced.
- No provider retry/backoff scheduler was added.
- No Vercel/Sentry post-preview validation was performed locally; that remains the post-push, pre-merge gate.

## Database, Supabase, and Tembo Impact

No migration expected and none added. This pass only changes route behavior, client refresh state, and observability. Supabase reads/writes are unchanged. Tembo role was not changed or assumed.

## Sentry and Logging Notes

Provider failures capture only safe metadata: area, provider, operation, transport, status/code, duration, and sanitized target host/path where applicable. The implementation does not log tokens, secrets, raw OAuth payloads, email bodies, request bodies, or private message content.

Expected 4xx-class provider failures are breadcrumbs/logs, not captured as Sentry exceptions. Network failures, timeouts, 5xx-class provider failures, and rate-limit/provider-error classifications are captured.
