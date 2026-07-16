# ADR 0006 — Envoy appearance and capability independence

- Status: accepted
- Date: 2026-07-16
- Wave: 15.0

## Context

Legacy Mascot couples Axiom, Codex, and Nova appearance with Focus, Intel, and
Ask behavior. The redesign needs extensible visual identity without losing
useful AI behavior, privacy, route context, focus management, or errors. It also
needs real background-work status before generic conversation.

## Options considered

1. Preserve character-bound modes and add more character variants — lowest
   migration cost, but appearance remains authority-like and non-extensible.
2. Make each Envoy own its own prompt/tools — flexible personalities, but
   duplicates capability logic and can change safety behavior with appearance.
3. Separate `activeEnvoyId` and `envoyPresence` from `Focus | Intel | Ask`; use
   one truthful active-work projection and one shared capability panel.

## Decision

Use option 3. Envoys render validated assets and status. Capability modes remain
shared Axis functions. A pure versioned migration maps all three legacy values
to stable starter IDs and preserves visibility plus Focus data. Status derives
from durable task/run/approval records and links to exact records.

## Rationale

Appearance becomes user preference, never permission or model behavior. One
active-work projection avoids client fan-out and prevents missing sections from
appearing idle. Existing interaction and safety behavior can be parity-tested
before legacy removal.

## Consequences

- AppShell dynamically loads EnvoyHost.
- Legacy Mascot stays until Focus/Intel/Ask, privacy, abort, navigation, dialog,
  and error parity pass.
- Interface Studio remains a quick picker; Envoy Lab owns management.
- Preference persistence needs versioning, successful-read write gates,
  unknown-field preservation, Realtime/polling conflict handling, and timezone
  regression tests.

## Reversal cost

Low before Mascot removal; medium after. Stable capability APIs remain usable by
either UI, and the legacy rollback switch stays until the parity wave closes.
