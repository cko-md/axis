# AXIS Deployment And Production Gate

AXIS deploys through GitHub PRs and Vercel previews. Agents should push branches and open PRs after local checks pass. Human Sentry review is not a pre-push blocker; Sentry is reviewed after the Vercel preview exists and before production readiness/merge.

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

- Preview build succeeds with required Supabase env present.
- Optional provider keys that are absent show setup/not-configured UI instead of crashing.
- Changed workflow is exercised on the preview URL, not only localhost.
- Error path is exercised when safe to do so and produces visible UI feedback.
- No secrets or private content appear in Vercel logs.
- `NEXT_PUBLIC_APP_URL` points to the intended preview/production origin where required for OAuth/CORS.
- Sentry tunnel `/monitoring` remains reachable and does not conflict with app routes.

## Sentry Checklist

- Sentry review happens post-push/post-preview.
- Happy-path preview validation creates no new error event.
- Forced or observed failures capture safe tags: route/operation, provider, transport, status, normalized code.
- Events never include tokens, OAuth payloads, email bodies, recipients, or private content.
- Source maps upload in Vercel when `SENTRY_AUTH_TOKEN`, org, and project are configured.

## Supabase And Tembo Checklist

- Confirm required Supabase env exists in Vercel Preview and Production.
- Confirm any changed table has owner-scoped RLS before merge.
- For no-migration PRs, state "no Supabase schema change" in the PR.
- Do not assume Tembo usage. Current AXIS runtime code does not use Tembo; if that changes, document its role before routing data to it.

## Production Readiness

Merging to `main` triggers the Vercel production deployment. Production readiness requires completed local checks, a healthy preview build, preview validation evidence, Supabase/Tembo impact notes, and post-preview Sentry review. Sentry review can happen after the PR is opened; it cannot be skipped before production merge.
