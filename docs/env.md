# AXIS Environment Variables

AXIS validates environment variables in `src/lib/env.ts`. `REQUIRED_ENV_NAMES` is the boot-time contract; `OPTIONAL_PROVIDER_ENV` groups every provider or workflow key that can be absent from a preview build. Supabase browser auth is the only boot-time requirement. Provider keys are optional unless a user enters the feature that needs them; missing optional keys must return a visible configured/not-configured state instead of crashing the app or build.

## Required

| Variable | Runtime | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Supabase project URL for auth and data sync. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | Supabase anon/publishable key for authenticated user sessions. |

If either required value is missing or invalid, `src/lib/env.ts` throws a clear startup/build error naming the variable.

## Recommended For Preview And Production

| Variable | Runtime | Purpose |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | browser + server | Canonical app origin for OAuth redirects and CORS allow-origin. |
| `NEXT_PUBLIC_SENTRY_DSN` | browser + server | Enables Sentry error/performance capture. Optional locally. |
| `SENTRY_AUTH_TOKEN` | build/CI | Allows `@sentry/nextjs` to upload source maps during Vercel builds. |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Trusted server operations such as pre-auth passkey support and webhook writes. |

## Optional Provider Keys

Missing optional keys should produce a configured/not-configured response, a setup message, or a graceful fallback. They must not crash preview builds.

| Feature | Variables |
|---|---|
| Composio transport | `COMPOSIO_API_KEY` |
| Direct Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Direct Microsoft OAuth | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| Polygon/Massive markets | `POLYGON_API_KEY` or `MASSIVE_API_KEY` |
| Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| Strava | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` |
| AI routing | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |
| Tavily search | `TAVILY_API_KEY` |
| Make | `MAKE_API_KEY`, `MAKE_TEAM_ID`, `MAKE_ZONE`, `MAKE_WEBHOOK_SECRET`, `MAKE_WEBHOOK_DAILY_BRIEF_URL`, `MAKE_WEBHOOK_WEEKLY_RECAP_URL`, `MAKE_WEBHOOK_BILL_REMINDER_URL`, `MAKE_WEBHOOK_BUDGET_ALERT_URL`, `MAKE_WEBHOOK_ANOMALY_ALERT_URL`, `MAKE_WEBHOOK_SUBSCRIPTION_AUDIT_URL` |
| Rate limiting / MFA throttling | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Passkey encryption | `PASSKEY_ENCRYPTION_KEY` |
| Health providers | `GARMIN_CLIENT_ID`, `OURA_CLIENT_ID`, `FITBIT_CLIENT_ID`, `WHOOP_CLIENT_ID` |
| Brokerage stubs | `APP_PUBLIC_API_KEY` or `PUBLIC_API_KEY` or `BROKERAGE_API_KEY`; `APP_PUBLIC_ACCOUNT_ID` or `PUBLIC_ACCOUNT_ID` or `BROKERAGE_ACCOUNT_ID`; `TRADE_EXECUTION_ENABLED` |
| Cron protection | `CRON_SECRET`, `FEED_DIGEST_SECRET`, `MAKE_SWEEP_SECRET` |

## Runtime Behavior

- Required Supabase variables are read through `getPublicEnv()` and fail with a clear message that points back to this file.
- Optional variables must be read with `optionalEnv()`, `hasOptionalEnv()`, or a feature helper such as `getPolygonApiKeyEnv()`.
- Missing optional providers should respond with `NOT_CONFIGURED`, a setup message, or an intentional fallback. Examples: Composio connect returns 503 `NOT_CONFIGURED`, Polygon/Massive routes return `POLYGON_API_KEY_NOT_CONFIGURED`, AI routes fall back to heuristics where supported, and Upstash rate limiting falls back to in-memory limits.
- Route-level Sentry capture should use `captureRouteError()` with safe tags only. Expected missing-config and user-error responses are breadcrumbs or visible API responses, not exception events.

## Sentry Safety

Sentry is configured in `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, and `src/instrumentation.ts`. Client replay masks text and blocks media. Server events include Vercel environment/release metadata when available. Server events must use safe metadata only: provider, route/operation, status, transport, and normalized error code. Never log tokens, OAuth payloads, full email bodies, recipients, or private message content.

## Tembo

Current repo config and code do not route runtime traffic to Tembo. Existing Tembo mentions are planning/audit notes only. If Tembo becomes active later, document whether it is primary Postgres, analytics Postgres, queue/cache, or unused before adding any env vars or data paths.
