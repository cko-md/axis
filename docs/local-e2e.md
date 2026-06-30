# Local Authenticated E2E

Use this workflow when authenticated Playwright tests need a real Supabase session without using a production account.

## Local Stack

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

Current expected result:

```text
2 passed
```

## Notes For Future Agents

- Keep `.auth/` out of git. It contains browser session state.
- If Playwright browser binaries were cleaned up, run `npx playwright install chromium`.
- If `npx supabase start` fails on duplicate migration versions or skipped migrations, inspect `supabase/migrations`; local Supabase requires unique ordered filename prefixes.
- If Colima fails to bind-mount the Docker socket for `supabase_vector_*`, disable local analytics/vector for this auth-state workflow.
- If Mailpit port `54324` is busy, use `54334` in `supabase/config.toml`.
- If frontend signup cannot reach local Supabase, check CSP `connect-src` in `next.config.ts` for `http://127.0.0.1:54321` and the password-check endpoint.
