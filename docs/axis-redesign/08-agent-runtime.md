# 08 — Task, routine & agent runtime

Status: Phase 9 complete for the current redesign scope. Documents what exists
on the branch.

## Tasks — the canonical unit of work

A durable agent-Task (not a chat thread) is the resumable record of work
(`src/lib/tasks/taskState.ts`, table `agent_tasks` + append-only
`agent_task_activity`).

- 12 statuses: `queued · gathering_data · researching · calculating ·
  waiting_for_data · waiting_for_user · waiting_for_approval · executing ·
  blocked · completed · failed · cancelled`.
- `TASK_TRANSITIONS` defines legal moves; `/api/agent-tasks/[id]` enforces
  `canTransition` **server-side** (illegal → 409), so history can't be
  corrupted. Terminal states stamp `completed_at`; every change appends an
  activity row.
- UI: the Tasks workbench (`/tasks`) offers only legal next statuses and shows
  linked approvals.

## Skills — reusable, deterministic methods

A Skill is *how* to perform a class of work. Today:
`skills/concentrationReview.ts` computes position weights and flags breaches,
and `skills/rebalanceProposal.ts` computes proposed order tickets from target
weights. Both are pure, deterministic, and tested. The plan's rule holds:
**skills that produce financial significance are deterministic code, not model
reasoning.** LLM use is limited to explain-only narration via `lib/ai/explain.ts`
with cost estimation; it cannot authoritatively compute financial values.

## Routines — *when* to run, with what

A Routine triggers a Skill and records a durable run. Today:

- `POST /api/routines/concentration-check` reads real holdings, runs the
  concentration skill, and creates a `queued` agent-Task per breach —
  idempotent (skips breaches with an open task).
- `POST /api/routines/rebalance-proposal` reads holdings, fetches live market
  prices, requires a complete fresh-or-delayed quote set, and persists a
  completed simulation with unsubmitted order drafts. It creates no execution
  approval and cannot submit orders; any future submission path must introduce
  a separate approval + fresh step-up + provider-idempotency boundary.
- `GET/POST /api/routines/versions`, `GET/PATCH
  /api/routines/versions/[id]`, and `POST /api/routines/versions/compare`
  provide routine version list/clone/restore/compare over code-defined built-ins
  and user-owned snapshots.

## Durable execution (§15.5)

Each run persists (`runState.ts`, tables `routine_runs` + `routine_step_runs`):

- run status (`queued · running · waiting_for_approval · blocked · completed ·
  partial · failed · cancelled`) and per-step status (`pending · running ·
  succeeded · failed · skipped`);
- input/output snapshots per step; `deriveRunOutcome` sets the final status;
- a thrown step marks the run blocked/failed with snapshots intact for
  inspection and safe retry/resume;
- approval-paused runs store pause metadata and resume through
  `/api/routines/runs/[id]/resume`, which re-checks the stored approval row via
  `isActionable`;
- cost fields record deterministic zero-cost runs and estimated LLM explanation
  cost.

`GET /api/routines/runs` returns run history (+ `?runId` with ordered steps);
the RoutineRunsPanel surfaces recent runs, run detail, step snapshots, and a
resume action for approval-waiting runs.

## Not yet built (tracked)

The conversational routine builder, subagents with bounded budgets, scheduled
and event triggers, and UI for editing routine definitions. The current
versioning API is intentionally persistence-first: clone/restore/compare, not a
visual builder.
