# Local Authenticated E2E

Use this workflow when authenticated Playwright tests need a real Supabase session without using a production account.

## No-Docker Fallback (sandboxed sessions)

Some agent sessions can't run Docker/Colima at all (no permission to start containers), so `npx supabase start` is not an option even though the CLI installs fine. In that case, substitute the **Supabase MCP connector** (already attached to this project — look for `apply_migration`, `execute_sql`, `list_migrations`, `get_advisors`, `create_branch`, `merge_branch`, `delete_branch` via ToolSearch) for both halves of this doc:

**Migration verification (replaces "Local Stack" SQL replay below):**
1. `create_branch` off `twkcvyhmlguipchfetge` — a real isolated Postgres branch, not a local container. **This is a billed resource; get explicit user confirmation before calling `create_branch`** (call `confirm_cost` first and show the user the amount).
2. `apply_migration` the pending migration(s) on the branch.
3. `execute_sql` to sanity-check the resulting schema/data; `get_advisors` (type: security) to catch missing RLS policies.
4. `merge_branch` to promote once satisfied, or `delete_branch` to discard and stop paying for it.

This satisfies AGENTS.md §8's "Automate migration application/verification... Use the configured Supabase CLI/API/connector" clause — the MCP connector counts as the connector.

**Authenticated E2E (replaces "Create Auth State" below):**
There's no way to fake Supabase Auth without Docker. Instead, point a locally-built app (`npm run build && npx next start`) at a real, disposable Supabase target — the branch created above, or a dedicated dev/staging project — rather than `127.0.0.1:54321`:
1. Get that target's URL/anon key (branch `project_ref`, or `get_project_url`/`get_publishable_keys`).
2. Create a disposable **confirmed** test user via the service-role admin API (through MCP `execute_sql`, or a direct admin API call) so there's no email-confirmation step to fake.
3. Run `npm run test:e2e:auth` with `E2E_BASE_URL`, `E2E_USER_EMAIL`, `E2E_USER_PASSWORD` pointed at that build, same as the "production build" section below.
4. Delete the disposable user (and the branch, if one was created) afterward.

This only needs outbound network to the real Supabase Auth/API — no Docker, no Colima.

## Local Stack (when Docker is available)

AXIS can run authenticated E2E against the Supabase CLI local stack.

```bash
colima start --cpu 2 --memory 3 --disk 20 --runtime docker --vm-type vz
npx supabase start
```

Known local settings:

- Supabase API: `http://127.0.0.1:54321`
- Supabase Studio: `http://127.0.0.1:54323`
- Mailpit/Inbucket: `http://127.0.0.1:54334`
- Local analytics/vector can stay disabled for auth E2E; DB, Auth, API, Storage, Studio, and Mailpit are enough.

Run the app against local Supabase:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY="<ANON_KEY from npx supabase status>" \
npm run dev -- --hostname 127.0.0.1
```

## Create Auth State

Create a local-only user through `/login` -> `Need an account? Sign up`.

If email confirmation is enabled, open Mailpit/Inbucket and use the local confirmation link:

```text
http://127.0.0.1:54334
```

Then save a Playwright auth state:

```bash
mkdir -p .auth
E2E_USER_EMAIL="<local test email>" \
E2E_USER_PASSWORD="<local test password>" \
npm run test:e2e:auth
```

Or, after `.auth/e2e-user.json` exists:

```bash
E2E_BASE_URL=http://127.0.0.1:3000 \
E2E_AUTH_STATE=.auth/e2e-user.json \
AXIS_E2E_AUTH=1 \
npm run test:e2e:auth
```

Current expected result (auth-setup + 3 authenticated specs):

```text
4 passed
```

## Run against a production build (recommended — avoids dev-server flakiness)

The Playwright `webServer` default runs `npm run dev`, whose **on-demand route
compilation** makes the first hit to each route slow (a cold `/login` can take
>10s) and races React hydration. Prefer running the suite against a production
build, where every route is precompiled:

```bash
npm run build
npx next start -H 127.0.0.1 -p 3000 &   # serve the prod build

E2E_BASE_URL=http://127.0.0.1:3000 \
E2E_USER_EMAIL="<test email>" \
E2E_USER_PASSWORD="<test password>" \
npm run test:e2e:auth     # 4 passed  (~8s)

E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e   # 10 public passed (~5s)
```

Setting `E2E_BASE_URL` makes Playwright use your already-running server instead
of spawning `npm run dev`. Verified 2026-07-06: **10 public + 4 authenticated
tests green** against the prod build (a fresh confirmed test user created via the
service-role admin API and deleted afterward).

`auth.setup.ts` is hydration-safe: it re-attempts the sign-in click until the
`sb-*-auth-token` cookie is set (rather than trusting a single click, which can
native-submit `/login?` before React hydrates — the login inputs have no `name`
attribute), then navigates to `/command` deterministically.

## Notes For Future Agents

- Keep `.auth/` out of git. It contains browser session state.
- If Playwright browser binaries were cleaned up, run `npx playwright install chromium`.
- If `npx supabase start` fails on duplicate migration versions or skipped migrations, inspect `supabase/migrations`; local Supabase requires unique ordered filename prefixes.
- If Colima fails to bind-mount the Docker socket for `supabase_vector_*`, disable local analytics/vector for this auth-state workflow.
- If Mailpit port `54324` is busy, use `54334` in `supabase/config.toml`.
- If frontend signup cannot reach local Supabase, check CSP `connect-src` in `next.config.ts` for `http://127.0.0.1:54321` and the password-check endpoint.
