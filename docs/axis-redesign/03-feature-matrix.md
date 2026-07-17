# 03 — Feature and requirement matrix

This matrix maps the redesign requirements to the implementation that currently
exists on the branch and to the evidence still required before production. It is
not a roadmap promise. Runtime truth is the code and migrations; program status
is tracked in [`PROGRAM_STATE.json`](../../.claude/axis-redesign/PROGRAM_STATE.json).
The historical assessment in [`13-final-verification.md`](13-final-verification.md)
is retained as a dated snapshot.

Status terms:

- **Implemented** — the complete local contract exists and has automated
  coverage.
- **Guarded** — the safe boundary exists, but a high-risk action is deliberately
  disabled.
- **External gate** — code is implemented, but production evidence needs a live
  provider, hosted service, preview, or human review.
- **Deferred** — intentionally outside the current redesign slice.

## Product, domain, and safety requirements

| Requirement | Status and implementation | Production gate or remaining dependency |
|---|---|---|
| Deterministic money arithmetic | **Implemented.** Integer minor-unit helpers and cent-exact aggregation live in [`money.ts`](../../src/lib/fund/money.ts); currency exponents and conversion boundaries live in [`currency.ts`](../../src/lib/fund/currency.ts). | Financial invariant tests must remain green; any new currency must declare its exponent before use. |
| Typed FX with provenance | **Implemented.** [`fx.ts`](../../src/lib/fund/fx.ts) rejects unsupported/mixed inputs and returns rate provenance rather than silently blending currencies. | Live rate-provider freshness and outage behavior must be exercised on preview when a provider is configured. |
| Tax lots and corporate actions | **Implemented.** FIFO/specific-lot basis, splits, dividends, and gain calculations are deterministic in [`taxLots.ts`](../../src/lib/fund/taxLots.ts). | Provider tax-lot import and brokerage reconciliation remain separate integration work. |
| Financial provenance, freshness, and reconciliation | **Implemented.** [`provenance.ts`](../../src/lib/fund/provenance.ts), provenance columns, freshness badges, and holdings reconciliation keep provider, timestamp, and conflict state visible. | Hosted migration read-back and live stale/partial/conflicting UI checks are required for each affected release. |
| Canonical entities without duplicating private content | **Implemented.** [`entities/types.ts`](../../src/lib/entities/types.ts), [`entities/registry.ts`](../../src/lib/entities/registry.ts), and owner-scoped resolvers project existing domain rows into typed references. | The entity-workspace migration must exist on the target; copied URLs must be tested against foreign and deleted records. |
| Search, previews, backlinks, and frecency | **Implemented.** Owner-resolved candidates, safe projections, typed references, and aggregate explicit-use counters live under [`src/lib/entities`](../../src/lib/entities). | Vercel preview must cover complete, partial-source, retry, reference-create/remove, and owner-isolation paths; post-preview Sentry review remains mandatory. |
| URL-restorable split workspace | **Implemented.** The bounded codec and pane state live under [`src/lib/workspace`](../../src/lib/workspace); only references, pane ids, widths, and bounded history enter the URL. | Preview coverage must include reload, browser history, mobile tabs, keyboard resize, malformed state, and URL-size caps. |
| Policy-typed command system | **Implemented.** Commands declare scope, execution kind, ownership, action class, and availability in [`command-palette-model.ts`](../../src/components/nav/command-palette-model.ts). | Preview must prove navigation and mutation failures remain visible and do not navigate on failure. |
| Semantic design system and accessibility baseline | **Implemented.** Status, typography, surface, motion, contrast, and shared-control contracts are documented in [`06-design-system.md`](06-design-system.md) and rendered at `/design-system`. | Cross-module visual regression remains incomplete; preview keyboard, reduced-motion, theme, and responsive checks are required. |
| Durable agent-Tasks | **Implemented.** The state machine is in [`taskState.ts`](../../src/lib/tasks/taskState.ts); persistence and compare-and-set writes are in [`taskPersistence.ts`](../../src/lib/tasks/taskPersistence.ts) and the task/approval atomic migration. | Hosted RPC/grant/RLS validation and concurrent-transition checks must pass; terminal records must never revive. |
| Typed action taxonomy and approval policy | **Implemented.** [`actionPolicy.ts`](../../src/lib/security/actionPolicy.ts) classifies reads, drafts, simulations, writes, communications, financial execution, and destructive administration. | Independent review is required for any change that can downgrade a requirement or add a new tool/action class. |
| Fully scoped approvals | **Implemented.** [`approvalRequest.ts`](../../src/lib/security/approvalRequest.ts) validates actor, exact tool/target, amount, before/after state, freshness, scope, and bounded expiry. | Hosted validation must prove malformed/backdated approvals cannot be created or consumed and that execution is exactly-once. |
| Real step-up authentication | **Implemented; external gate.** Passkey registration/authentication and exact one-time challenge consumption use the WebAuthn routes and [`webauthn/server.ts`](../../src/lib/webauthn/server.ts). | Manual platform-authenticator and hardware/security-key ceremonies plus independent security sign-off remain required. |
| No autonomous financial execution | **Guarded.** [`publicOrderAdapter.ts`](../../src/lib/brokerage/publicOrderAdapter.ts) can prepare/verify a draft but `submit` is disabled; rebalance produces unsubmitted order drafts only. | A future submitter requires a separate reviewed server-side approval consumer, fresh step-up, broker idempotency, reconciliation, and live sandbox evidence. |
| Durable routine runs and resumable steps | **Implemented.** [`runState.ts`](../../src/lib/routines/runState.ts), [`executor.ts`](../../src/lib/routines/executor.ts), and [`resumeClaims.ts`](../../src/lib/routines/resumeClaims.ts) persist snapshots and fence resume claims. | Local and hosted race validation must prove one claim/step/terminal writer wins and stale claim tokens cannot mutate a run. |
| Routine version history | **Implemented.** Built-in definitions and owner snapshots support compare, clone, and restore through [`versioning.ts`](../../src/lib/routines/versioning.ts). | Conversational editing and scheduled/event triggers are deferred. |
| Concentration review | **Implemented.** Deterministic concentration math creates idempotent review Tasks; it does not trade. See [`concentrationCheck.ts`](../../src/lib/routines/concentrationCheck.ts). | Live holdings, empty holdings, duplicate retry, and partial/error behavior must be exercised on preview. |
| Rebalance proposal | **Guarded simulation.** [`rebalance-proposal/route.ts`](../../src/app/api/routines/rebalance-proposal/route.ts) requires a complete fresh/delayed quote set and records simulation-only order drafts. | Provider-backed quote validation remains external; submission is intentionally unavailable. |
| Inspectable memory and financial operating profile | **Implemented.** Memory is bounded, owner-scoped context with immutable provenance; it cannot grant authority. See [`memory-center.md`](../architecture/memory-center.md). | Hosted two-user isolation and archive/restore/profile persistence must remain green. |
| Need-to-Know signal queue | **Implemented.** Severity, deterministic deduplication/resolution memory, task conversion, and visible lifecycle states are wired into Dispatch. See [`severity.ts`](../../src/lib/signals/severity.ts). | Preview must exercise critical/actionable/informational/noise, empty/error, and persistence paths. |

## Integration, operations, and quality requirements

| Requirement | Status and implementation | Production gate or remaining dependency |
|---|---|---|
| One normalized provider-result contract | **Implemented foundation.** [`integrations/types.ts`](../../src/lib/integrations/types.ts) defines `Result<T>` and normalized safe errors. Mail, Plaid, market data, Public preparation, and Make use this boundary to varying depths. | Calendar and Contacts are not yet adapterized; new integrations must not leak provider payloads into domain/UI code. |
| Mail parity across direct and Composio transports | **Implemented contract; external parity gate.** Four adapters implement [`MailAdapter`](../../src/lib/mail/adapters/types.ts); inbox is cache-first per [`mail-cache-sync.md`](../architecture/mail-cache-sync.md). | Current live evidence covers an active Composio Gmail list/detail path. Direct Gmail and direct/Composio Outlook need active-account validation; unsupported Outlook-Composio mutations must remain disabled. |
| Cache-first provider reads with visible freshness | **Implemented for Mail and widgets.** Supabase stores normalized last-known metadata; provider refresh is explicit and failures retain visible stale rows. | Cache privacy columns, owner RLS, stale/partial/error UX, and provider recovery must be rechecked on preview. |
| Safe external communication delivery | **Implemented for Make notifications.** Encrypted payloads, hashed dedupe keys, compare-and-set claims, bounded attempts, dead-letter state, and explicit replay are documented in [`make-notifications.md`](../architecture/make-notifications.md). | Live Make write/dedupe verification is still required; Axis treats `2xx` as accepted, not delivered. |
| Provider ownership and capability enforcement | **Implemented foundation.** Routes resolve authenticated owner accounts before adapter selection; [`registry.ts`](../../src/lib/integrations/registry.ts) advertises transport capabilities. | Registry capability claims require contract tests and live confirmation before enabling UI affordances. |
| Performance budgets | **Implemented for the current profiling pass.** Aggregate and per-route budgets live in [`PERFORMANCE_BUDGETS.json`](../../.claude/axis-redesign/PERFORMANCE_BUDGETS.json) and are enforced by build-log scripts. | Reprofile after shell, route, or dependency changes; investigate rather than raising a budget without evidence. |
| Structured, privacy-safe observability | **Implemented locally; external gate.** Redacted events, provider timing, route capture, and Sentry scrubbing live under [`src/lib/observability`](../../src/lib/observability). | Sentry dashboards/alerts and a release-scoped post-preview regression review must be recorded; see [`14-observability-dashboards.md`](14-observability-dashboards.md). |
| Automated release gates | **Implemented on branch.** CI runs lint, typecheck, release manifest validation, unit tests, build, bundle budgets, public smoke, and a local-Supabase authenticated suite. | The workflow itself must pass on the PR; hosted expansion/contract migration evidence, preview checks, and Sentry evidence remain outside the local gate. |
| Safe expand/application/contract deployment | **Implemented as a release contract.** The ordered migrations and release validator are documented in [`11-migration-plan.md`](11-migration-plan.md) and [`12-release-plan.md`](12-release-plan.md). | Never apply the contract migration until the compatible application revision is live and recovery ownership is recorded. |

## Deliberately incomplete capabilities

The current program does not claim completion of a conversational routine
builder, bounded subagent execution, scheduled/event triggers, universal
provider-backed search, saved named workspaces, generalized financial execution,
Calendar/Contacts adapters, full visual regression, or every live provider
matrix cell. These remain deferred or external-gated rather than represented by
mock data or enabled-but-unverified actions.

Production readiness is conjunctive: local/CI gates, hosted database validation,
Vercel preview workflow checks, provider checks for every enabled capability,
post-preview Sentry review, and the applicable human security review must all
pass.
