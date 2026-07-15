# 02 — Product Synthesis: Macro + Town → Axis

Classification: **Adopt** (build as-is), **Adapt** (reshape for Axis/finance),
**Reject** (do not build), **Defer** (later wave). Mapped to surfaces that
already exist in the repo where possible.

## Macro-derived

| Capability | Class | Axis mapping / notes |
| ---------- | ----- | -------------------- |
| Canonical typed entities + references | Adapt | New `src/lib/entities/*` typed registry; back existing modules with it incrementally. |
| Backlinks | Adapt | Derived from typed references; surface in entity detail. |
| Hover previews | Adopt | Extend existing `search/` + `command/` result rendering. |
| Split panes / per-pane history | Defer | Only after routing + state ownership support it cleanly (Phase 7). |
| Command palette + scoped commands | Adopt | `src/app/command`, `src/components/nav` already exist — formalize a command registry (id/scope/permission/analytics). |
| Unified frecency search | Adapt | `src/components/search` exists — add entity filters + inspectable frecency ranking. |
| Local-first / normalized cache | Adapt | Build on `docs/architecture/widget-cache.md`; add visible freshness states. |

## Town-derived

| Capability | Class | Axis mapping / notes |
| ---------- | ----- | -------------------- |
| Need-to-Know signal queue | Adapt | `src/app/signals` exists → severity tiers (critical/actionable/informational/noise), dedup, resolution memory, convert-to-task. |
| Shared Tasks (durable state machine) | Adapt | Reshape `objectives`/`pipeline` around the `FinancialTaskStatus` state machine; chat is an interface to a task, not the record. |
| Routines (versioned, triggered) | Adapt | `briefing`/`debrief`/daily jobs → versioned `RoutineDefinition` + durable `RoutineRun` steps. |
| Skills (reusable playbooks) | Adopt | Versioned, typed I/O, allowed tools, evidence + freshness rules. |
| Memory Center | Adapt | Structured `MemoryItem` with provenance/scope/confidence/expiry; user-inspectable. |
| Per-tool permissions + read/draft/simulate/execute | Adopt | Central policy kernel (Phase 5). |
| Durable resumable runs + run history | Adopt | Step idempotency keys, input snapshots, resume tokens. |
| Approval queue + detailed approval cards | Adopt | Never a bare "Allow"; show full scope, before/after, freshness, reversal path. |
| Cost/usage metering | Adopt | Per-run/routine/monthly budgets; fail safe on exhaustion. |
| Conversational routine builder + dry run | Adapt | Compiled config beside builder chat; historical + synthetic dry runs. |
| Integration context/tool-count indicators | Adopt | Extend integrations UI. |
| AI research documents | Adapt | Build on `notes`/`literature` (TipTap already present) → investment research workspace with citations + financial metadata. |

## Reject / avoid

Autonomous financial execution by default · hidden/uneditable memory · chat as
canonical work record · blending provider accounts without provenance · LLMs as
the authoritative calculation engine · raw private chain-of-thought as a
"reasoning trace" · all MCP tools enabled in every routine · persistent
session-wide "allow all" financial permissions · content from email/web
authorizing actions.

## First-wave selection (lowest regret, highest leverage)

Financial precision foundation (Phase 4) precedes cosmetic redesign because
several Fund widgets aggregate money with float drift. **Landed:**
`src/lib/fund/money.ts`. Next candidates in dependency order: provenance fields
on financial values → reconciliation states → Task state machine → signal
severity tiers.
