# 07 — Security & financial-safety model

Status: implemented core (Phase 5). This documents what exists on the branch.

## Action taxonomy

Every agent/routine action is classified (`src/lib/security/actionPolicy.ts`):

`READ · DRAFT · SIMULATE · INTERNAL_WRITE · EXTERNAL_COMMUNICATION · FINANCIAL_EXECUTION · DESTRUCTIVE_ADMIN`

Baseline approval requirement per class: reads/drafts/simulations run `auto`;
internal writes and external communication need `approval`; financial execution
and destructive admin need `approval_step_up`.

## Decision rules (pure, tested)

`decideApproval(context)`:

- **Combinatorial prompt-injection rule (mandatory approval):** an
  outbound/executing action that both touches sensitive data **and** was
  influenced by untrusted external content must be approved — the
  "read an emailed instruction, then move money" confused-deputy pattern is a
  policy stop, not a prompt-engineering hope.
- `explicitlyTrusted` may downgrade an INTERNAL_WRITE to auto, but **never**
  financial execution, destructive admin, or anything caught by the
  combinatorial rule.

## Approval object & execution gate

- `approvalRequest.ts` — `ApprovalRequest`; `validateApprovalCompleteness`
  ("never a bare Allow": outbound/executing need freshness+expiry, execution
  needs amount/account/before+after, destructive needs before-state);
  `isActionable` = complete + unexpired + step-up satisfied.
- Persisted append-only in `approvals`; `/api/approvals/[id]` execute path
  **re-runs `isActionable` against the stored row** and records only that the
  gate passed — it never performs the underlying side-effecting action.
- **No autonomous financial execution.** Persistent scope is impossible for
  financial-execution / destructive-admin.

## Step-up authentication

`approvals.step_up_verified_at` is set **only** by a verified WebAuthn passkey
assertion (`/api/approvals/[id]/step-up`), by the approval's owner, against an
exact one-time ceremony bound to purpose, approval, RP origin, and expiry.
Delete-returning challenge consumption and expected-counter compare-and-set
admit one winner. Execution rejects step-up older than five minutes. The old
self-attestable client boolean was removed.

Passkey login verifies the same exact ceremony boundary, mints a fresh one-time
Supabase link server-side, consumes it through the SSR client, and verifies the
resulting session owner. No refresh token is stored with a passkey and no token
exchange route exists. Automated virtual-platform-authenticator coverage passes;
physical authenticator testing and independent human sign-off remain open.

## Data boundaries & least privilege

- Owner-scoped reads remain available for task/approval/run state, but trusted
  lifecycle mutations use narrow RPCs or authenticated owner-scoped server
  routes with service-role persistence. Browser DML is revoked for task
  creation/activity, approvals, routine runs, and routine steps.
- `user_passkeys` and `webauthn_challenges` intentionally have zero browser
  policies/grants. Credential counters and pending ceremonies are server-owned
  authority, not generic owner-write data.
- Task creation atomically writes the task and initial activity and verifies
  any routine provenance against the owner, routine key, live claim token,
  lease, and quarantine state.
- Approval-resume work uses renewable caller-token leases; routine step writes
  and task creation are claim-fenced. Stale recovery invalidates the old token,
  quarantines the run for operator review, and blocks generic retry.
- Integration risk model (`integrations/risk.ts`) maps provider capabilities to
  action classes → approval defaults, so integrations are organized by
  capability/risk and routines inherit the right defaults.
- Untrusted external content is data, never authority.

## Observability without leakage

`observability/events.ts` emits structured events with a tested redaction guard
that masks token/secret/password/authorization/cookie/api-key/PII keys at any
depth — safe metadata only.

## Deterministic finance

All monetary arithmetic runs through `fund/money.ts` (integer minor units); the
model never computes authoritative financial values. Provenance + freshness
(`fund/provenance.ts`, `FreshnessBadge`) keep delayed data from reading as
real-time.
