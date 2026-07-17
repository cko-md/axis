# VECTOR + Envoys evidence index

Per-wave logs live here. Each log records:

- revision and invariant;
- planned versus delivered scope;
- full changed-file list;
- migration, grant, RLS, and Storage impact;
- architecture, security, UX, accessibility, and adversarial review;
- targeted/full commands and counts;
- browser QA and screenshot paths;
- performance measurements;
- defect-ledger delta;
- independent verifier result;
- commit and remaining blockers.

Current:

- `premortem.md` — deep pre-mortem and owner decision
- `skill-preflight.md` — required skill source/read/use evidence
- `design-review.md` — concept selection and multi-skill review
- `wave-15.0-program-foundation.md` — planning/design foundation (landed)
- `wave-15.1-integration-safety.md` — current-main/Phase 9 integration,
  preference, passkey/session authority, and lifecycle concurrency hardening;
  local migration/replay/RLS/WebAuthn evidence (two-parent merge landed from
  `960d20f4` + `a029cd58392a75497113685b9363c4f3e617f672`).
  Hosted Supabase DDL/readback, Vercel protected-preview access, Sentry
  project/event read, Render, and OpenAI gates remain explicitly `BLOCKED`.
- `wave-15.2-platform.md` — shared VECTOR lobby/runtime, owner-partitioned local
  persistence, cloud-path code plus local SQL evidence, and protocol-v3 offline
  installation (local validation in progress). All nine games remain truthfully
  planned. Its canonical hosted-gate table records production Supabase, Vercel,
  Sentry, Render, and OpenAI as explicitly `BLOCKED`, with the exact checks and
  human owners required to clear them.
- `final-completion-audit.md` — requirement-by-requirement proof (pending)
