# ADR 0007 — Envoy owner reversal requires a fresh, capability-independent design

- Status: accepted
- Date: 2026-07-23
- Phase: 0 — release and truth containment
- Supersedes: the 2026-07-19 Envoy drop decision and its "do not re-attempt" implementation posture

## Context

The 2026-07-19 decision removed the prior Envoy implementation after the owner
rejected its visual and UX direction. That removal remains a historical fact;
it is not evidence that an Envoy product, generation plane, or worker exists
today. The retired Meridian, Cairn, Vesper, and Solace visual system must not
be restored as a shortcut.

The owner has now authorized a new Envoy program. The program needs an
explicit governance boundary before any product, schema, worker, or art work
begins, so a reversal cannot accidentally revive the rejected design or weaken
the existing financial/action safety kernel.

## Decision

1. **Authorize a fresh Envoy design.** This ADR supersedes the 2026-07-19
   drop only as a decision not to pursue Envoys. It does not restore removed
   code, art, routes, schema, workers, or completion claims.
2. **Forbid resurrection of the retired visual system.** Meridian, Cairn,
   Vesper, Solace, their art, names, palettes, motion language, and associated
   UI direction are retired. New identities require original concept evidence
   and their own validation; renamed or lightly edited versions do not qualify.
3. **Keep appearance independent of capability.** Selecting, generating,
   renaming, archiving, or rendering an Envoy must not alter the behavior,
   authority, permissions, routing, or policy of Focus, Intel, or Ask.
4. **Preserve authority boundaries.** Envoys are a status and navigation
   surface. They may show truthful durable work and link to its exact task,
   run, approval, or result, but may not approve, execute, trade, send, or
   otherwise exercise financial or action authority. Existing approval,
   step-up, deterministic-money, provider-partitioning, and untrusted-content
   rules remain binding.
5. **Use the new dependency order.** The only authorized order is E0 through
   E6 in the Envoy acceptance matrix. Envoy Arena cannot begin until at least
   eight validated, selectable identities exist; four initial concepts are not
   sufficient.
6. **Retain Legacy Mascot as rollback.** Mascot remains available until the
   new Envoy host has verified functional and operational parity. Removal is a
   later, separately evidenced change, never a prerequisite or side effect of
   this ADR.

## Consequences

- The new program begins at E0. Governance acceptance is not implementation
  completion; all product and infrastructure stages remain unbuilt/open.
- Any prior document saying Envoys are dropped or must not be re-attempted is
  superseded for governance purposes. Historical removal statements remain
  useful only as history and as a prohibition on resurrecting the retired
  design.
- A later code wave that needs persistence must add an additive migration and
  owner/service RLS review. A paid provider or worker remains gated by the
  documented private-storage, quota, fixture-first, hosted-validation, and
  observability requirements.

## Acceptance record

The authoritative prospective checklist is
[`../envoy-acceptance-matrix.md`](../envoy-acceptance-matrix.md). It is the
source for E0–E6 status; no row may move from `open` based on this ADR alone.
