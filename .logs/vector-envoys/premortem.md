# VECTOR + Envoys pre-mortem

- Mode: deep
- Date: 2026-07-16
- Context: full program before implementation
- Decision: owner accepted all recommended mitigations; no high risk waived
- Source note: supplied brief has 2,241 lines and ends mid-sentence after the
  instruction to start with `grill-me`; all substantive requirements, gates,
  definition of done, and final report fields appear before that truncation.

## Verified tigers

Twenty-one binding risk controls are recorded as `VE-RISK-001` through
`VE-RISK-021` in `docs/axis-redesign/15-vector-arcade-and-envoys.md`.

Evidence groups:

- preference/timezone integration and transient-load overwrite;
- offline owner partition, service-worker cache boundary, API auth, and build
  manifest completeness;
- bundle headroom, focused-game input geometry, engine lifecycle, motion, and
  browser matrix;
- legacy preference migration, truthful active-work projection, transition
  races, retry-safe approval resume, deep links, AI error/abort parity;
- worker column authority, lease fencing, idle heartbeat, transactional quota,
  path containment, retry accounting, checkpoint durability, independent QA,
  worker CI, and production access.

## Paper tigers and false alarms

- Tracked Workbox code is inert: no current `/sw.js` or registration imports it.
  Risk begins when a new root worker is introduced or upgrades an older client.
- CSP already allows same-origin/blob workers.
- Global CSS already supplies focus-visible and CSS reduced-motion foundations;
  Canvas/WebGL still need runtime-level handling.
- AppShell's existing clock/media/keyboard/resize effects clean up. Missing
  lifecycle ownership concerns future game engines, audio, and worker resources.
- Private Storage is established in the repository; Envoys can reuse its
  owner-first-path pattern with stricter service boundaries.
- GPT image transparency and wide atlas constraints do not block the pipeline;
  chroma-key cleanup and API-safe staging grids are explicit adaptations.

## Quick re-check after mitigation

All high risks now map to a wave, test evidence, and rollback/forward-fix rule.
No accepted mitigation introduces a second source of truth or an alternate
production execution path. Remaining external access is a delivery gate, not a
reason to weaken implementation.
