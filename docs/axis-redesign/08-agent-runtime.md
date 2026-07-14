# 08 — Task, routine & agent runtime

Status: implemented core (Phases 8–9). Documents what exists on the branch.

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

A Skill is *how* to perform a class of work. Today: `skills/concentrationReview.ts`
— pure, cent-exact, tested; computes position weights and flags breaches. The
plan's rule holds: **skills that produce financial significance are deterministic
code, not model reasoning.** LLM-judgment skill steps (explain/classify/summarize
only) are future work.

## Routines — *when* to run, with what

A Routine triggers a Skill and records a durable run. Today: the
concentration-check routine (`/api/routines/concentration-check`), manually
triggered (also from the ⌘K palette). It reads real holdings, runs the skill,
and creates a `queued` agent-Task per breach — idempotent (skips breaches with
an open task).

## Durable execution (§15.5)

Each run persists (`runState.ts`, tables `routine_runs` + `routine_step_runs`):

- run status (`queued · running · waiting_for_approval · blocked · completed ·
  partial · failed · cancelled`) and per-step status (`pending · running ·
  succeeded · failed · skipped`);
- input/output snapshots per step; `deriveRunOutcome` sets the final status;
- a thrown step marks the run failed with snapshots intact for inspection;
- cost fields recorded (0 for deterministic runs).

`GET /api/routines/runs` returns run history (+ `?runId` with ordered steps);
the RoutineRunsPanel surfaces recent runs.

## Not yet built (tracked)

Resume-after-approval executor (state + storage support it today), the
conversational routine builder, LLM-judgment steps with cost metering, subagents
with bounded budgets, and scheduled/event triggers.
