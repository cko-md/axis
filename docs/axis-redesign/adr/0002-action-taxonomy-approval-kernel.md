# ADR 0002 — Action taxonomy & approval kernel

- Status: accepted
- Date: 2026-07-13
- Wave: Phase 5.1–5.4

## Context

Agents and routines can take actions ranging from reading a balance to placing a
trade. The program (§11) requires that significance and authority be decided by
typed, testable code — never free-form model reasoning — and that financial
execution never happen autonomously. We also need a defense against the
confused-deputy / prompt-injection pattern where untrusted external content
(an email, a web page) triggers a sensitive outbound action.

## Options considered

1. **Per-call boolean flags** (`requiresApproval`) scattered at each call site.
   Untestable, drifts, easy to forget for a new tool.
2. **A single action taxonomy + pure policy function**, with a durable approval
   object and an `isActionable` gate re-checked at execution time.
3. **Model-decided approvals** (ask the LLM whether to approve). Rejected: makes
   the model the authority, exactly what the safety kernel forbids.

## Decision

Option 2, in pure modules:

- `actionPolicy.ts` — `ActionClass` (READ…DESTRUCTIVE_ADMIN), a baseline
  requirement per class, and `decideApproval(context)` that escalates on the
  **combinatorial rule** (sensitive data + untrusted external content +
  outbound/executing ⇒ mandatory approval) and forbids downgrading financial
  execution / destructive admin.
- `approvalRequest.ts` — the `ApprovalRequest` object, `validateApprovalCompleteness`
  ("never a bare Allow"), and `isActionable` (complete + unexpired + step-up
  satisfied) as the single execution gate.
- Persistence (`approvals` table, append-only) + `/api/approvals` re-run the gate
  against the **stored** row at execute time; the route records that the gate
  passed and never performs the underlying side-effecting action.

## Rationale

One typed, unit-tested place for the rules, reused by the runtime, API, and UI.
The execute path never trusts a client-supplied version of the request. Step-up
and completeness are enforced structurally, so a UI cannot even offer an
under-scoped approval.

## Consequences

- Approvals are empty until a real execution skill produces genuine order
  details — an honest empty state, not fabricated rows.
- Step-up is currently a timestamp column + gate; binding it to a real WebAuthn
  challenge is a follow-up.
- The execute endpoint deliberately stops at "cleared"; wiring a real broker
  order behind it is a future, separately-reviewed wave.

## Reversal cost

Low–medium. Pure modules are additive; the tables are additive with owner-scoped
RLS. No existing behavior depends on them yet.
