# Memory Center and Financial Operating Profile

The Memory Center is an inspectable, owner-scoped context store. It makes the
information Axis remembers visible and editable instead of hiding durable user
context inside prompts, provider payloads, or application defaults.

## Authority boundary

Memory is context, never authority. A memory item or financial profile may shape
deterministic defaults and explanations, but it cannot approve an action, satisfy
step-up authentication, authorize financial execution, or bypass the action
taxonomy and approval kernel. API schemas reject fields outside the documented
context contracts.

## Storage and ownership

- `memory_items` stores bounded preferences, constraints, goals, and context with
  scope, provenance, confidence, optional expiry, and active/archive lifecycle.
- `financial_operating_profiles` stores one user-confirmed profile per owner,
  including integer-basis-point concentration limits.
- Both tables are Supabase-backed, require an authenticated owner, and use RLS
  for owner-scoped select, insert, and update. Authenticated hard delete and all
  anonymous access are denied; memory uses archival instead.
- Provider-imported and system-observed provenance values are reserved for future
  trusted server ingestion. The current user API always writes `user_asserted`.

## Routine consumption

New concentration-check runs resolve their limit in this order:

1. A valid explicit request value.
2. The user's confirmed financial profile, converted deterministically from
   integer basis points.
3. The existing 25 percent routine default.

The selected value and its provenance are copied into the immutable run input
snapshot. Resumes replay that snapshot, so later profile edits cannot change an
in-flight decision. Invalid request values receive a visible `400` response and
are never silently replaced.

## User workflow

`/memory` supports profile read/update and memory list/create/edit/archive/restore
with loading, empty, signed-out, failure, busy, confirmation, and success states.
No local-storage fallback is used.
