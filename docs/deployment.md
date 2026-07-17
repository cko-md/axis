# AXIS Deployment And Production Gate

AXIS deploys through GitHub PRs and Vercel previews. Agents should push branches and open PRs after local checks pass. Human Sentry review is not a pre-push blocker; Sentry is reviewed after the Vercel preview exists and before production readiness/merge.

Vercel's Git integration is the only production deployment owner. Merging to
`main` creates the production deploy; GitHub Actions must not also run
`vercel deploy --prod`. Manual CLI production deploys are reserved for
documented incident recovery.

## PR Flow

1. Confirm the Linear issue and branch name.
2. Inspect the scoped files and document expected behavior.
3. Implement one focused issue.
4. Run `npx tsc --noEmit` and `npm run lint`; run targeted tests when relevant.
5. Commit, push, and open the PR.
6. Let Vercel create a preview deployment.
7. Validate happy path and error path on the preview URL.
8. Review Sentry after preview validation.
9. Merge only after preview, Supabase/Tembo, and Sentry evidence are acceptable.

## Vercel Preview Checklist

- Preview build runs on Node.js 24.x.
- Preview build succeeds with required Supabase env present.
- Preview build succeeds when optional provider keys are absent: `COMPOSIO_API_KEY`, `POLYGON_API_KEY`/`MASSIVE_API_KEY`, `PLAID_*`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `MAKE_*`, `UPSTASH_*`, health provider IDs, and brokerage keys.
- Optional provider keys that are absent show setup/not-configured UI or API responses instead of crashing.
- Check optional-provider probes on the preview URL:
  - `GET /api/massive/status` returns configured status without throwing.
  - `GET /api/ai/status` reports configured AI providers or heuristic fallback.
  - `GET /api/plaid/status` reports connected/not-connected or a visible status error.
  - Composio connect/status flows return `NOT_CONFIGURED` or a stored status when `COMPOSIO_API_KEY` is absent.
- Changed workflow is exercised on the preview URL, not only localhost.
- Authenticated Playwright smoke checks run with `npm run test:e2e:auth` using either `E2E_AUTH_STATE` or `E2E_USER_EMAIL` + `E2E_USER_PASSWORD`.
- For local Supabase-backed auth-state setup, see `docs/local-e2e.md`.
- Error path is exercised when safe to do so and produces visible UI feedback.
- No secrets or private content appear in Vercel logs.
- `NEXT_PUBLIC_APP_URL` points to the intended preview/production origin where required for OAuth/CORS.
- Sentry tunnel `/monitoring` remains reachable and does not conflict with app routes.
- Vercel logs do not show startup failures from missing optional provider keys.

## Sentry Checklist

- Sentry review happens post-push/post-preview.
- Happy-path preview validation creates no new error event.
- Forced or observed failures capture safe tags: route/operation, provider, transport, status, normalized code.
- Missing optional provider responses such as `NOT_CONFIGURED` are not captured as exceptions.
- Events never include tokens, OAuth payloads, email bodies, recipients, or private content.
- Source maps upload in Vercel when `SENTRY_AUTH_TOKEN`, org, and project are configured.
- Server, edge, and client events show the expected Vercel environment/release metadata when available.

## Supabase And Tembo Checklist

- Confirm required Supabase env exists in Vercel Preview and Production.
- Confirm any changed table has owner-scoped RLS before merge.
- For no-migration PRs, state "no Supabase schema change" in the PR.
- For the 2026-07-16 RPC cutover, follow the deterministic
  [expand → application → contract runbook](axis-redesign/12-release-plan.md).
  The contract migration is forbidden until the compatible Git SHA is Ready in
  production.
- Do not assume Tembo usage. Current AXIS runtime code does not use Tembo; if that changes, document its role before routing data to it.

## Production Readiness

Merging to `main` triggers one Vercel Git-integration production deployment.
Production readiness requires completed local checks, a healthy preview build,
preview validation evidence, Supabase/Tembo impact notes, and post-preview
Sentry review. Sentry review can happen after the PR is opened; it cannot be
skipped before production merge.
