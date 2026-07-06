# AXIS Production Readiness

> Phase 8 (PROD-*) working record. Evidence-based; RLS/migration facts below were
> queried against the live Supabase project on 2026-07-03. Re-run the checks in
> §4 before each production promotion — this is the repeatable gate.

Supabase project: `twkcvyhmlguipchfetge`. Vercel auto-deploys `main`.

---

## 1. RLS verification (PROD-3) — PASS

Queried against the live database (`pg_tables` / `pg_policies` / `pg_policy`):

- **Every** table in `public` has RLS **enabled** and at least one policy — zero tables with RLS off or zero policies.
- **No overly-permissive policies**: no `USING (true)` / `WITH CHECK (true)` policy exists that isn't scoped by `auth.uid()` / `user_id`.
- **Every `user_id`-owned table enforces ownership** via `auth.uid() = user_id`, with one intentional exception:
  - `webauthn_challenges` — policy `service_role_only` is `USING (false)` for role `public`. This is **correct**: WebAuthn challenges are written/read only server-side with the service key (which bypasses RLS) during the pre-authentication ceremony, so all client (anon + authenticated) access is denied by design.

Re-run this audit any time:

```sql
-- tables missing RLS or policies (expect 0 rows)
select t.tablename, c.relrowsecurity, count(p.polname) policies
from pg_tables t
join pg_class c on c.relname=t.tablename and c.relnamespace='public'::regnamespace
left join pg_policy p on p.polrelid=c.oid
where t.schemaname='public'
group by t.tablename, c.relrowsecurity
having c.relrowsecurity=false or count(p.polname)=0;

-- user_id tables whose policies don't reference auth.uid() (expect only webauthn_challenges)
with owned as (
  select c.relname tablename from pg_attribute a
  join pg_class c on c.oid=a.attrelid
  where a.attname='user_id' and c.relnamespace='public'::regnamespace and c.relkind='r')
select o.tablename
from owned o left join pg_policies p on p.tablename=o.tablename and p.schemaname='public'
group by o.tablename
having count(*) filter (where coalesce(p.qual,'')||coalesce(p.with_check,'') ilike '%auth.uid%')=0;
```

Supabase security advisors (`get_advisors type=security`): only `auth_leaked_password_protection` (WARN) — Supabase's built-in HaveIBeenPwned check requires the Pro plan. **Implemented at the application layer instead** (no Pro, no schema needed): `src/lib/auth/passwordCheck.ts` runs the HIBP Pwned-Passwords **k-anonymity** range check (only a 5-char SHA-1 prefix leaves the server; `Add-Padding: true`; fails open on API/network error). Enforced server-side on password change (`/api/auth/account`) and client-side pre-check on signup (`/login`). The pure `rangeContainsSuffix` parser requires `count > 0` so padding entries can't false-positive; unit-tested in `passwordCheck.test.ts`. The Supabase advisor WARN can be ignored (or the toggle enabled if you later upgrade to Pro — the app-layer check is harmless alongside it).

---

## 2. Migration ordering / replay audit (PROD-1) — DRIFT, needs human reconciliation

The local `supabase/migrations/` file set (**59 files**) does **not** match the remote applied migration history (**62 entries**). Local files sort correctly lexically (numeric `001-049` prefixes sort before the newer `2026…` timestamp prefixes; interleaved `0281`/`030x` prefixes sort within their neighbours as intended), so *local* ordering is internally consistent — but it has diverged from what production actually applied. Confirmed mismatches:

| Concern | Local file | Remote applied | Risk |
|---|---|---|---|
| Same number, different migration | `011_cleanup_functions.sql` | `011_avatars_bucket` | `011_cleanup_functions` has **no matching remote entry** — application status unverified |
| Untracked prod change | *(none)* | `profiles_bio` (20260625224935) | Schema change applied to prod with **no local migration file** |
| Prefix ≠ applied order | `048_fund_connections_plaid_token_columns.sql` | applied at `20260621075140` (early) | Local prefix implies late; actually applied early |
| Prefix ≠ applied order | `025_task_completed_at.sql` | applied as `020_task_completed_at` | Numbering renumbered locally after apply |

**Do not auto-reconcile.** Rewriting migration history or renaming files can corrupt Supabase's tracked state and break `supabase db push` idempotency. Recommended human steps:
1. Treat the **remote applied history as source of truth** (it reflects real prod schema).
2. Recover a local migration file for `profiles_bio` (dump the column(s) it added) so the repo can rebuild the schema from scratch.
3. Verify `011_cleanup_functions.sql` is either applied under another version or is obsolete; if its functions exist in prod, backfill a tracked entry; if not, decide whether it's still needed.
4. Going forward, use `supabase migration new` (timestamp prefixes) so numbering never collides again — the newest migrations already follow this (`2026…`).

New migrations added this session (both applied live + advisor-clean): `calendar_event_cache` (CAL-3), `key_result_progress` (+ `_user_index`) (OBJ-2).

---

## 3. Generated Supabase types (PROD-2) — PARTIAL (types committed; wiring deferred)

`src/lib/supabase/database.types.ts` is generated from the live DB (62 tables) and committed as a reference artifact.

**Version skew resolved:** `@supabase/ssr` was bumped 0.6.1 → **0.12.0** (peer-deps `supabase-js ^2.108`, matching the installed 2.108) — a clean drop-in (0 errors, cookie API unchanged). This was the blocker: under 0.6.1 the `Database` generic didn't propagate and every query resolved to `never` (**340 errors**). With 0.12.0, wiring `createClient<Database>()` drops that to **22 real errors** — the generic now works.

**The generic wiring surfaced 5 genuine latent bugs — FIXED this pass** (they were querying columns that don't exist, silently erroring at runtime):
- `api/search`: `schedule_events.start_time/end_time` → `start_at/end_at`.
- `api/fund/report`: selected `fund_holdings.last_price` (nonexistent) → removed; uses `cost_basis`.
- `api/agenda/rebuild`: read `display_name` from `user_preferences` (wrong table — it's on `profiles`, so the user's name always fell back to "the user") → now from `profiles`; `objectives.category` → `descriptor`.

**COMPLETE (as of 2026-07-06):** `createClient<Database>()` is now wired in both `client.ts`+`server.ts`; all 22 mechanical ORM-boundary casts resolved (targeted `as Json`/null-guard/payload casts — no `as any`) across `useTasks`, `useSignals`, `useFitnessRoutines`, `{mail,calendar,contacts}/tokens`, `fund/{advisor,liabilities,bank-transactions}`, `calendar/{sync,external}`, `widgets/batch`, `feeds/cached`, `integrations/composio/status`, `notes` study-aid insert. Wiring the generic surfaced+fixed 8 latent bugs (wrong column names, missing NOT-NULL `user_id`, nonexistent columns). `main` is 0-error with the generic live. **Regenerate types after every migration.**

---

## 4. Repeatable production gate (PROD-5 / PROD-6)

Run before promoting `main` to production:

1. **Local build & checks** (all must pass): `npx tsc --noEmit` · `npm run lint` · `npm run test` · `npm run build`. (If `next build` fails on a stale `.next/types/*` "file not found", `rm -rf .next` and rebuild — it's a cache artifact, not a code error.)
2. **Supabase**: if migrations changed, apply via MCP/CLI and re-run the §1 RLS queries + `get_advisors security`; confirm no new tables lack owner-scoped RLS.
3. **Vercel preview**: validate happy + error paths on the preview URL (not just local). Confirm the preview build succeeds.
4. **Sentry (post-preview)**: confirm the happy paths create **no** new Sentry issue; confirm intentional error paths emit tagged events with **no** PII (no tokens, email/note bodies, health/financial data, contact PII, or raw provider payloads).
5. **Manual workflow smoke** (the daily loop): Console capture → Dispatch route → Agenda task → Schedule block → Notes reference; plus one beta module (Objectives/Fund) and one lab module render check.
6. **Cross-theme spot check**: dark / dim / slate / silver-light on Command, Mail, Notes, Fund, Control Room.
7. Promote only after the above pass and the change is human-approved. Production deploy = merge to `main` (Vercel promotes automatically).

---

## 5. Status snapshot (2026-07-03)

- Phases 0–4 complete and on `main`; Phase 5 substantial (OBJ-2 progress-history feature + theme guards); Phase 6 theme/Debrief fixes on `main`.
- RLS: verified clean (§1). Migrations: drift documented (§2), needs reconciliation before treating the repo as a from-scratch source of truth.
- **PROD-4 (e2e smoke) — DONE for the public surface.** `tests/e2e/smoke.spec.ts` (Playwright `public` project) covers home, legal, 404, and every production nav route + the legacy `/console`,`/signals` resolving without an error boundary pre-auth — **10 public tests verified passing locally** against a dev server + Chromium (`npm run test:e2e`). Authenticated smoke (`authenticated.spec.ts`, incl. the DISP-3 `/console→/command` & `/signals→/dispatch` redirect assertions) runs under `AXIS_E2E_AUTH=1` (`npm run test:e2e:auth`) and needs a seeded test login — **not run this session** (no test credentials here); run it in CI/with creds before treating the authed paths as gated.
- **AI-1..4 — DONE** (typed registry `src/lib/ai/actions.ts` + `callAiAction`, all call sites migrated/fixed, `privacy.test.ts` logging guard). See handoff.
- Leaked-password protection (§1): **DONE at the app layer** (HIBP k-anonymity, no Pro/schema); Supabase advisor WARN is expected and can be ignored.
- Remaining open Phase-8: migration-drift reconciliation (§2, human decision). PROD-2 typed client is now **fully wired** (§3). Market/quotes shared caching is an optional FUND perf follow-on, not a maturity blocker.

---

## 6. Adversarial codebase audit (2026-07-06)

Full-codebase adversarial review across UI/UX, security/privacy, design, code, bugs, and module maturity. **No exploitable defects or fake-data honesty violations found** — the platform is production-mature. Checks and results:

**Security / privacy (thorough):**
- **AuthZ / IDOR** — all 10 dynamic `[id]`/`[symbol]` API routes scope by `user_id`/`getUser()`. No IDOR. Of 114 routes, the 13 without a user check are legitimately public (market-data proxy, academic literature feed, provider-status, webhooks, pre-auth passkey).
- **Webhooks** — Plaid (`plaid-verification` JWT via `verifyPlaidWebhook`) and Make (`x-make-secret` shared secret **+** HMAC-SHA256 with a length-guarded `timingSafeEqual`) verify before touching the admin client.
- **XSS** — both `dangerouslySetInnerHTML` sinks (mail `MessagePanel`, WebViewer reader) render DOMPurify-sanitized HTML with strict tag/attr allowlists (no event handlers, no `data-*`). Reader HTML is also SSRF-guarded upstream.
- **RLS-bypass admin client** — confined to signature-verified webhooks, `CRON_SECRET`-guarded crons, and pre-auth WebAuthn lookups. All 4 cron routes check `CRON_SECRET`.
- **Secrets** — none hardcoded; all via env helpers. **Log privacy** — `ai/privacy.test.ts` enforces no payload identifiers in AI-route logs.

**Code / bugs:**
- Zero `TODO`/`FIXME`/`HACK`/`@ts-ignore`/`@ts-nocheck` in non-test src.
- No "silent-failure" client fetches — every `await fetch` file has `.ok`/status/throw/catch handling.
- **Financial correctness verified** — `cost_basis` is consistently *total* (whole-position) across `snapshotNetWorth`, `position/[symbol]`, `FundNetWorthModule`, holdings aggregation; live (`shares×price`) and fallback (`costBasis`) paths compute the same quantity. No net-worth miscalculation.
- Gate green: `tsc` clean · `lint` clean · **334 unit tests pass** · production build succeeds.

**UI/UX / design / maturity:**
- App-Router robustness: `error.tsx`, `global-error.tsx`, `not-found.tsx` present.
- a11y: no `<img>` without `alt`; broad `aria-label` usage.
- Runtime: landing renders with **zero console errors**; all 16 module routes compile and redirect to auth (no 500s).
- Honest degradation (not fake data): Vitality HealthKit "coming soon" panel, training-widget graceful stub, brokerage "not wired to live execution" (made honest by the fund-order-safety rescue), Schedule/Debrief demo content shown **only when signed-out** — all clearly labeled.

**Rescue work landed this pass:** 4 preserved codex-rescue branches — `8608807` (notes study-aid typed AI), `f56bcdb` (honest fund order-capture states), `2c3f6c9` (calendar-sync discovery errors + test), `756d647` (mail/calendar status-error surfacing; also removed a dead duplicate `connectionsError` block and fixed a silent-UI-failure error shape in `calendar/external`).
