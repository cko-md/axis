# 10 — Testing strategy and release evidence

Testing follows the risk boundary, not a single coverage percentage. Pure
financial and policy code receives exhaustive invariant tests; database
concurrency is proven against Postgres; complete browser workflows run against
an authenticated Supabase stack; provider claims require live evidence.

## Test layers

| Layer | Purpose and examples | Required evidence |
|---|---|---|
| Unit | Pure state machines, parsers, presenters, ranking, money/currency/FX, tax lots, portfolio math, provenance, redaction | `npm run test`; deterministic fixtures, boundary values, invalid input, and fail-closed behavior. |
| Property/invariant | Rules that must hold across many inputs: aggregation order independence, round-trip conversion within currency precision, lot conservation, transition terminality, idempotency-key stability, URL-codec bounds | Current suite uses explicit cases, deterministic loops, and invariant assertions (for example [`money.test.ts`](../../src/lib/fund/money.test.ts) and [`taxLots.test.ts`](../../src/lib/fund/taxLots.test.ts)). A property-testing library may be added only with deterministic seeds and reproducible failure output. |
| Adapter contract | Every provider/transport returns the same normalized success/error shapes and respects capabilities | Shared contract suites plus provider-specific normalization, pagination, retry, and unsupported-operation tests; see [`mail/adapters`](../../src/lib/mail/adapters) and [`integration-adapters.md`](../architecture/integration-adapters.md). |
| Route/service | Authentication, ownership, validation, error-to-HTTP mapping, persistence intent, safe Sentry metadata | Vitest route tests with owner, foreign-owner, signed-out, invalid, provider failure, and partial success cases. |
| Database/RLS | Constraints, grants, owner isolation, append-only posture, `SECURITY DEFINER` search paths, compare-and-set races | Fresh local migration apply/reapply, two-user rollback probes, catalog read-back, and the dedicated validators under [`scripts`](../../scripts). |
| Browser end-to-end | Complete `list → detail → action → persistence → feedback → error` workflows | Public and authenticated Playwright projects in [`tests/e2e`](../../tests/e2e), run against a production build where possible. |
| Visual and accessibility | Responsive layout, themes, contrast, focus, keyboard, reduced motion, dialogs, non-color state | Automated semantic/contrast tests plus Playwright screenshots/interaction checks at desktop and mobile widths. Full cross-module visual baselines remain an open gate. |
| Provider-backed | Real OAuth/Composio/provider shapes, account lifecycle, rate/auth errors, write acknowledgement and recovery | Explicit provider matrix run on Vercel preview using non-production data; never infer parity from mocks. |
| Security/adversarial | Prompt-injection authority separation, malformed approvals, replay/races, owner forgery, secret/PII scrubbing | Focused unit/route tests, database race validators, manual WebAuthn ceremony, dependency audit, and independent review for high-risk boundaries. |
| Performance | Bundle size, route first-load JS, provider fan-out, cache-first behavior, latency/error budgets | Production build plus aggregate/per-route budget scripts and preview telemetry. |

## Financial and policy invariants

The following are release-blocking:

- money aggregation is exact in declared minor units and independent of input
  order;
- currency mismatch fails instead of implicitly converting;
- FX results carry rate provenance/freshness;
- consumed plus remaining tax-lot quantity equals the original quantity;
- task/run/step terminal states cannot transition;
- approval policy cannot be downgraded for external communication, financial
  execution, destructive administration, or the untrusted-content rule;
- financial approvals are complete, one-time, bounded, recent, and step-up
  verified;
- AI explanations cannot replace deterministic result fields or authorize an
  action.

Pure implementations and their tests live under
[`src/lib/fund`](../../src/lib/fund),
[`src/lib/security`](../../src/lib/security),
[`src/lib/tasks`](../../src/lib/tasks), and
[`src/lib/routines`](../../src/lib/routines).

## Database and concurrency tests

Schema work is not complete when SQL parses. Tests must prove:

- RLS is enabled and `anon` has no unintended access;
- owner A cannot read or mutate owner B;
- authenticated browser roles have only intended table/RPC grants;
- every `SECURITY DEFINER` function has a fixed safe `search_path`;
- referenced owner rows are validated inside the function;
- concurrent decisions/transitions/claims have exactly one winner;
- stale tokens, expected-state mismatches, replays, and malformed persisted
  scope fail closed;
- audit/activity writes commit with the state change;
- contract migrations remove legacy direct browser writes only after the
  compatible application is live;
- any policy-derived local grant bootstrap preserves the final privilege
  contract, and authenticated passkey insert/update/delete attempts fail at the
  table-privilege boundary.

Dedicated executable checks:

- [`validate-task-approval-cas.mjs`](../../scripts/validate-task-approval-cas.mjs)
- [`validate-webauthn-atomic.mjs`](../../scripts/validate-webauthn-atomic.mjs)
- [`validate-routine-resume-claims.mjs`](../../scripts/validate-routine-resume-claims.mjs)
- release read-back SQL under [`scripts/sql`](../../scripts/sql)

PR CI runs the contract read-back immediately after deriving local Data API
grants. This ordering is intentional: the fresh stack must test the final
migration state and prove that bootstrap logic cannot re-grant lifecycle DML.

These validators create temporary users/data and clean them up or run inside
rollback transactions. They must refuse an unintended hosted target unless the
release procedure explicitly authorizes it.

## Browser workflow matrix

Every changed user workflow covers:

1. signed-out or permission-denied;
2. initial loading;
3. empty/disconnected;
4. happy list and detail;
5. action busy state;
6. success feedback;
7. provider/database failure with visible retry or recovery;
8. refresh and persistence;
9. foreign/stale/deleted entity;
10. desktop/mobile and keyboard operation.

The current public/authenticated configuration is in
[`playwright.config.ts`](../../playwright.config.ts). High-value authenticated
coverage includes the workspace/search/reference flows, Tasks/Approvals/routine
flows, design-system accessibility, preferences, and module persistence.
Provider-backed tests are a separate gate because local fixtures cannot prove a
live OAuth/tool contract.

## Visual and accessibility policy

Semantic tests pin contrast and accessible component behavior, but they do not
catch every layout regression. A production-affecting UI change must exercise:

- Dark, Dim, Slate, and Light themes plus relevant accent states;
- 1440/1024/768/390/320-class widths as applicable;
- keyboard-only navigation and visible focus;
- Escape, focus trap, and focus restoration for dialogs;
- reduced motion;
- loading, empty, stale, partial, error, destructive-confirmation, and success
  states;
- screenshots or reviewed artifacts for the changed surface.

Cross-module golden visual regression is not yet complete and must not be
reported as implemented.

## Provider contract and live matrix

Automated tests own normalization, error mapping, capabilities, pagination,
cache reconciliation, and retry/idempotency rules. A live preview run owns
provider truth:

- direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook are separate
  matrix cells;
- list, detail, send/reply, mutations, attachments, auth expiry, rate limit,
  not found, and provider outage are separate operations;
- disabled/unsupported capabilities must render as disabled or relabeled, not
  fail after a click;
- Plaid/market/Make/Public evidence is recorded per enabled operation, never as
  a provider-wide blanket claim.

If credentials or an active account are unavailable, the capability remains an
explicit external production gate.

## CI and environment gates

Minimum local/PR commands:

```bash
npm ci
npm run lint
npx tsc --noEmit
npm run release:validate
npm run test
npm run build
node scripts/check-bundle-budget.mjs
node scripts/check-perf-budgets.mjs build.log
```

The CI workflow in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
also runs public smoke and a secret-free authenticated suite against a fresh
local Supabase stack. The workflow result is the authority; a local pass does
not substitute for a red CI job.

Environment responsibilities:

| Environment | What it proves |
|---|---|
| Unit process | Pure logic, parsers, route boundaries, contracts. |
| Local Supabase | Migration execution, RPCs, RLS/grants, races, authenticated browser workflows. |
| CI fresh stack | Reproducibility from checkout and migration history, production build, browser regressions. |
| Hosted Supabase | The intended project has the exact expansion/contract schema and grants. |
| Vercel preview | Production-like environment variables, routing/cookies, responsive workflows, provider integration, performance. |
| Sentry/Vercel telemetry | No release-scoped error, latency, or privacy regression after preview. |

## Test data and privacy

Use deterministic synthetic owners, opaque ids, and non-production provider
accounts. Never snapshot tokens, email bodies, contacts, bank/account numbers,
OAuth payloads, WebAuthn material, webhook URLs, or raw provider responses.
Failure output contains safe codes/status/counts only. Temporary users and rows
are removed after local/provider checks.

## Production exit criteria

A release is production-ready only when:

- all required CI jobs are green;
- applicable database validators and hosted read-back pass;
- the changed browser workflows pass on the Vercel preview;
- every enabled provider capability has current live evidence or is explicitly
  disabled;
- required visual/accessibility and manual WebAuthn/security checks are signed
  off;
- performance budgets pass;
- release-scoped Sentry/Vercel queries show no new regression;
- rollback/recovery ownership and migration stage are recorded.
