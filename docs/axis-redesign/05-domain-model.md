# 05 — Domain model and invariants

AXIS keeps each module as the source of truth and adds typed overlays only where
cross-module behavior needs them. Supabase Postgres is the durable store;
deterministic TypeScript owns financial calculations and state-machine rules.
Generative output may explain a result but is never the authoritative value or
the source of permission.

## Aggregate map

| Aggregate | Durable records | Domain contract | Ownership and mutation boundary |
|---|---|---|---|
| Module entities | Existing notes, people, signals, Agenda tasks, Fund accounts/holdings, and related module tables | Module hooks/services plus typed projections under [`src/lib/entities`](../../src/lib/entities) | Existing owner RLS remains authoritative; the entity layer never copies private content into a universal table. |
| Canonical identity | `entity_references`, `entity_usage` | [`EntityRef`](../../src/lib/entities/types.ts), registry, owner resolvers, ranking | Authenticated clients read their rows; narrow `SECURITY DEFINER` RPCs derive `auth.uid()` and validate both endpoints before mutation. |
| Agent work | `agent_tasks`, append-only `agent_task_activity` | [`taskState.ts`](../../src/lib/tasks/taskState.ts), [`taskPersistence.ts`](../../src/lib/tasks/taskPersistence.ts) | `user_id` owns every row. Server/service RPCs create and transition atomically; browser direct mutation is removed by the contract migration. |
| Approvals | `approvals` plus task activity | [`actionPolicy.ts`](../../src/lib/security/actionPolicy.ts), [`approvalRequest.ts`](../../src/lib/security/approvalRequest.ts) | Owner reads; service-only creation/decision/step-up/consumption RPCs. No delete path: decisions remain audit evidence. |
| Routine execution | `routine_runs`, `routine_step_runs`, `routine_versions` | [`runState.ts`](../../src/lib/routines/runState.ts), [`executor.ts`](../../src/lib/routines/executor.ts), [`resumeClaims.ts`](../../src/lib/routines/resumeClaims.ts) | Owner reads; claimed server execution is fenced by owner, run id, claim token, lease, and attempt. |
| Memory/profile | `memory_items`, `financial_operating_profiles` | [`memory/contracts.ts`](../../src/lib/memory/contracts.ts) | Owner select/insert/update; archive instead of hard delete. Memory is context only and cannot satisfy an approval or step-up. |
| Provider cache | `widget_cache`, `mail_message_cache`, `integration_sync_state`, calendar/feed caches | Normalized cache mappers and visible freshness contracts | Owner-scoped rows; caches are derived and may be rebuilt. Tokens, bodies, attachments, and raw provider payloads are excluded. |
| External-delivery outbox | `integration_delivery_outbox` plus immutable audit metadata | [`makeOutbox.ts`](../../src/lib/integrations/makeOutbox.ts) | Owner may read safe metadata only; payload ciphertext, dedupe hashes, claims, and writes are service-only. |

`tasks` and `agent_tasks` are intentionally different aggregates: `tasks` is the
Agenda/to-do record; `agent_tasks` is the durable agent-work record. Canonical
entity kind `agenda_task` distinguishes the former from entity kind `task`.

## Financial value objects

### Money and currency

- Authoritative arithmetic uses integer minor units. [`money.ts`](../../src/lib/fund/money.ts)
  provides the two-decimal compatibility helpers; [`currency.ts`](../../src/lib/fund/currency.ts)
  owns per-currency exponents.
- Major-unit numbers exist only at input, serialization, and display
  boundaries. Values must be normalized before aggregation.
- Non-finite input never enters a calculation. Unsupported currency behavior
  must be explicit; cross-currency values are not summed without a typed FX
  conversion.
- Quantity precision is separate from money precision. Tax lots use integer
  micro-shares in [`taxLots.ts`](../../src/lib/fund/taxLots.ts).

### FX and provenance

An FX conversion in [`fx.ts`](../../src/lib/fund/fx.ts) carries source currency,
target currency, rate, provider/source, retrieval timestamp, and derived
provenance. A financial value is not trustworthy merely because it is numeric.
[`Provenance`](../../src/lib/fund/provenance.ts) records source, provider,
retrieval/as-of timestamps, confidence/notes where applicable, and a
reconciliation state.

Freshness is one of `fresh`, `delayed`, `stale`, or `unknown`. Financial
execution approvals accept only a complete recent `fresh` or `delayed` data
snapshot; the approval kernel currently caps financial data age at 15 minutes.
A future-dated timestamp beyond clock skew fails closed.

Reconciliation is one of `matched`, `partial`, `conflicting`, `missing`,
`stale`, or `pending`. Conflicting provider values remain partitioned; the UI
may explain the conflict but must not silently select or blend a winner.

## Canonical identity invariants

- `EntityRef = { kind, id }`; kinds and id normalization are owned by
  [`registry.ts`](../../src/lib/entities/registry.ts).
- Existing module rows remain authoritative. Server projections expose a strict
  allowlist of preview fields and perform no live provider call.
- A reference edge is valid only when the same authenticated owner owns both
  endpoint entities. Deleting or losing ownership of an endpoint removes or
  invalidates the edge.
- Usage stores aggregate counters/timestamps for explicit `direct`, `search`,
  `command`, and `link` actions. It never stores raw queries or previews.
- Workspace URL state is ephemeral transport, not durable content. The codec
  permits bounded references/topology/history only; base64url is not encryption.

## Task lifecycle invariants

The exact statuses and legal transitions are defined in
[`taskState.ts`](../../src/lib/tasks/taskState.ts):

`queued`, `gathering_data`, `researching`, `calculating`,
`waiting_for_data`, `waiting_for_user`, `waiting_for_approval`, `executing`,
`blocked`, `completed`, `failed`, and `cancelled`.

Permitted transitions form loops between active and waiting states; the source
map, rather than a simplified linear diagram, is authoritative.

- `completed`, `failed`, and `cancelled` are terminal and have no successors.
- Every accepted transition commits the task update and one activity row in the
  same database operation.
- Compare-and-set uses the expected status; concurrent writers have one winner.
- `completed_at` is present only for terminal states.
- An idempotency key is unique per owner. Replaying the same semantic task
  returns the existing row; a payload mismatch is rejected.
- UI affordances are advisory. The server/database transition gate is the
  authority.

## Approval lifecycle and authority invariants

The durable lifecycle is:

`pending → approved|denied|expired`, then `approved → executed|expired`.

- A generic status transition cannot mark an approval `executed`. Only the
  policy-aware consumer may do so.
- The request is rebuilt and validated from the stored row, never from
  client-supplied execution scope.
- Every approval names an actor, exact tool, summary, action class, target,
  reasons, and scope. Outbound/execution actions also require freshness and a
  bounded expiry; financial execution requires positive amount/currency,
  account, before state, and after state.
- Financial execution and destructive administration are always `one_time`.
- Financial execution/destructive administration require fresh WebAuthn
  step-up. The assertion is bound to the exact approval and one-time challenge;
  sibling challenges survive and replay is rejected.
- Decision and execution use compare-and-set semantics. One concurrent decision
  or consumption wins; audit rows are appended exactly once.
- Approval does not itself prove provider success. Execution must separately
  verify idempotency, provider acknowledgement, and reconciliation.

## Routine and step invariants

Run statuses are `queued`, `running`, `waiting_for_approval`, `blocked`,
`completed`, `partial`, `failed`, and `cancelled`. Step statuses are `pending`,
`running`, `succeeded`, `failed`, and `skipped`; terminal steps are immutable.

- Inputs and completed outputs are snapshotted. Resume reuses succeeded output
  rather than recomputing completed steps.
- A paused run stores the exact step, approval, and run idempotency key.
- Resume first obtains a short lease. Only the matching claim token may start,
  finish, fail, repause, or complete claimed work; expired/stale tokens are
  fenced.
- The stored approval is revalidated for owner, status, completeness, expiry,
  step-up freshness, and routine scope at claim and terminal commit.
- Financial approval consumption and the run's terminal write commit together.
- Side-effect keys are stable, fixed-size hashes of owner/run/step/operation
  identity. Provider-backed writes need their own idempotency boundary before
  they can be enabled.
- `partial` means both success and failure exist; an empty/all-skipped run is a
  successful no-op.

## Ownership, RLS, and data classification

Every user-owned row carries `user_id`; owner policies use
`auth.uid() = user_id`. RLS is defense in depth, not a substitute for route
authentication and ownership lookup. `SECURITY DEFINER` functions must use a
fixed empty `search_path`, derive or validate the owner, validate all referenced
rows, and expose execute only to the minimum role.

| Class | Examples | Persistence rule |
|---|---|---|
| Authoritative private data | Tasks, approvals, financial records, memory, routine snapshots | Supabase owner rows with RLS and explicit grants. |
| Derived cache | Mail headers/snippets, widget values, sync state | Rebuildable, visibly stale, owner-scoped; no secrets/raw bodies. |
| Audit evidence | Task activity, approval decisions, routine history, safe delivery metadata | Append-only/no delete where practical; safe metadata only. |
| Secret material | OAuth/access tokens, WebAuthn challenge/session material, webhook URLs, encryption keys | Server-side encrypted store or environment only; never returned/logged. |
| Ephemeral client state | Pane focus/history, dialog state, search query | Memory/URL only within strict bounds; not persisted as private content. |

The current application has no configured Tembo data path. Supabase remains the
only documented application database; no domain entity may be routed to Tembo
until an explicit role, privacy boundary, and owner decision are recorded.
