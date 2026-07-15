# ADR 0003 — Durable agent-Tasks and routine runs

- Status: accepted
- Date: 2026-07-14
- Wave: Phase 8.1–8.4, 9.1–9.2

## Context

The program (§14.6, §15.5) makes a Task — not a chat thread — the canonical,
resumable unit of agent work, and requires routine executions to be durable and
auditable (resume after an approval pause without recomputing completed steps).
The repo already has a `public.tasks` table, but it is the user's to-do/Agenda
list — a different concept from an agent-Task.

## Options considered

1. **Reuse `public.tasks`** for agent work. Rejected: the drafted migration used
   `create table if not exists public.tasks`, which would silently no-op against
   the existing to-do table and mis-link approvals to to-do rows (caught during
   pre-apply DB inspection).
2. **Namespaced `agent_*` tables + pure state machines**, with lifecycle rules in
   typed code enforced at every write boundary.

## Decision

Option 2:

- `agent_tasks` / `agent_task_activity` (append-only) back `taskState.ts`
  (12-status machine, `canTransition`/`assertTransition`). The API enforces
  transitions server-side (illegal ⇒ 409), so history cannot be corrupted.
- `routine_runs` / `routine_step_runs` back `runState.ts` (run/step statuses +
  `deriveRunOutcome`). Each routine execution opens a run and records each step
  with input/output snapshots; a thrown step marks the run failed with snapshots
  intact.
- Status lifecycles live in pure code (asserted), with DB `check` constraints as
  a backstop — mirrored exactly (verified against the live constraints).

## Rationale

The rule lives in one tested place and is enforced identically by runtime, API,
and UI. Snapshots make runs inspectable and resumable. Namespacing avoids a
dangerous collision with existing data.

## Consequences

- Two task concepts now coexist (`tasks` = to-do, `agent_tasks` = agent work);
  the nav labels the new one "Tasks" under the Operate section. A future
  convergence, if desired, is a separate decision.
- Resume-after-approval reuses recorded step snapshots; the executor that pauses
  a run on `waiting_for_approval` and resumes it is a follow-up (the state and
  storage support it today).

## Reversal cost

Low. Additive tables with owner-scoped RLS; pure state machines; no existing
behavior depends on them.
