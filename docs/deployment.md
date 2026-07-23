# AXIS Deployment And Production Gate

AXIS deploys through GitHub PRs and Vercel previews. Agents should push branches and open PRs after local checks pass. Human Sentry review is not a pre-push blocker; Sentry is reviewed after the Vercel preview exists and before production readiness/merge.

Vercel's Git integration is the only production deployment owner. A source
merge to `main` creates a production attempt that the canonical-state gate
skips; the following protected state-refresh merge creates the production
build. GitHub Actions must not also run `vercel deploy --prod`. Manual CLI
production deploys are reserved for documented incident recovery.

Production is intentionally a two-merge operation. `vercel.json` runs a
reviewed inline `sh -c` mapping around `scripts/vercel-ignore-build.sh` using
Vercel's `ignoreCommand` convention (exit `0` cancels/skips; non-zero builds),
as defined by
[Vercel's project configuration](https://vercel.com/docs/project-configuration/vercel-json#ignore-command):

1. A source or authored-policy merge may deploy to a PR preview, but its
   production deployment is skipped because its canonical state was derived
   before that content existed on `main`.
2. From the updated `main`, run `npm run state:derive` (or
   `npm run state:derive:gates` for fresh local source-gate evidence), commit
   only the two generated state artifacts, and merge that protected state
   refresh.
3. The state-refresh merge builds production because its recorded source tree
   and source-main tree are identical.

The production decision hashes the checked-out tree and does not require
history, a network call, or a secret, so it remains fail-closed in Vercel's
depth-limited shallow clone. Preview and development deployments always
continue. A missing or unknown `VERCEL_ENV`, or a missing, invalid, or stale
state snapshot, cancels/skips production.

Both shell layers are part of the fail-closed boundary. The Node policy never
returns Vercel's build code directly; it emits a final
`AXIS_VERCEL_DECISION=BUILD` sentinel with child status `73`. The repository
wrapper maps only that exact pair to status `74`. The immutable inline command
in `vercel.json` maps only wrapper status `74` to Vercel's non-zero build result.
Missing or syntax-invalid wrappers, Node syntax/import/runtime crashes,
malformed output, and every other result map to exit `0`, so an unexpected
startup failure cannot accidentally authorize a production build.

Production additionally requires `gates.measured: true` bound to the exact
content-tree hash. A normal state refresh preserves an earlier measured pass
only when its content-tree hash is unchanged (as it is across an equivalent
squash merge). If the hash changed or no measured evidence exists, run
`npm run state:derive:gates`; Vercel skips production until that measured
snapshot is committed through the protected refresh.

The SHA-256 state fingerprint is deterministic consistency evidence, not a
cryptographic signature or an independent attestation: candidate authors can
recompute it. Production authority therefore depends on the immutable
base-controlled `release-governance` job in
`.github/workflows/release-governance.yml` plus every protected hosted check.
That trusted job executes validator code from the protected base, treats the
candidate only as inert data, freezes release-critical workflow/script
semantics, dependency and config/toolchain inputs, critical gate tests, and
protected test paths; it rejects lower measured unit-test totals/files/suites,
independently compares the candidate snapshot to the protected base, and must
pass before merge. Every protected-base test remains byte-identical; new
coverage is additive. The complete `vercel.json` is also byte-for-byte frozen,
so candidate build commands, environment variables such as `NODE_OPTIONS`, and
other deployment controls cannot perturb the gate while preserving only the
visible `ignoreCommand`. The active `postcss.config.mjs` and
`tailwind.config.ts` are likewise frozen, and alternate recognized root config
filenames are forbidden so CSS config discovery cannot select a candidate
shadow config or plugin. The semantic value of a newly added test remains a
code-review concern. The Vercel ignore command is a final fail-closed
consistency interlock; it does not replace branch protection or attest that a
candidate-reported gate ran.

Bootstrap caveat: the PR that first introduces `release-governance.yml` cannot
receive a `pull_request_target` check from a workflow that does not yet exist on
its protected base. Its production attempt must remain canceled. Immediately
after that bootstrap merge, make `release-governance` a required branch context;
only the following protected state-refresh PR may authorize the production
build.

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

Merging source to `main` creates one Vercel Git-integration production
deployment attempt, which the state gate skips. The subsequent protected
canonical-state refresh is the merge that triggers the production build.
Production readiness requires completed local checks, a healthy preview build,
preview validation evidence, Supabase/Tembo impact notes, and post-preview
Sentry review. Sentry review can happen after the PR is opened; it cannot be
skipped before production merge.
