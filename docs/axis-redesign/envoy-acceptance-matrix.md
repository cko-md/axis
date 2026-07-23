# Envoy acceptance matrix — fresh design program

- Status: open
- Date: 2026-07-23
- Governing decision: [ADR 0007](adr/0007-envoy-owner-reversal-and-fresh-design.md)
- Rule: `accepted` governance is not implementation completion. Every product,
  persistence, worker, asset, and hosted-proof row below is currently
  **unbuilt/open**.

| Order | Scope | Status | Closure evidence |
|---|---|---|---|
| E0 | Governance, canonical-state reconciliation, this matrix, and original concept evidence | open — ADR accepted only | Original, reviewed concept evidence; no retired Meridian/Cairn/Vesper/Solace system reused |
| E1 | `EnvoyWorkViewV1`: strict durable status projection and exact task/run/approval/result links | open — unbuilt | Truthfulness/degradation/deep-link tests and browser evidence; no invented percentages |
| E2 | Static original Envoy product and Lab: identities, validated artifacts, preferences, accessibility, privacy/cost/history surfaces | open — unbuilt | Original identity validation, preference migration, interaction/a11y/mobile/reduced-motion evidence |
| E3 | Feature-flagged Envoy host: status-first modes, realtime plus bounded polling, hidden/game pause, rollback parity | open — unbuilt | Capability-independence, lifecycle, error, deep-link, and Mascot rollback/parity evidence |
| E4 | Owner-scoped generation control plane: jobs, assets, cost, private Storage, APIs, quotas, RPCs, RLS | open — unbuilt | Additive migration; owner/cross-user/Storage/RPC/lease/worker-health tests |
| E5 | Deterministic leased worker with pinned Hatch tooling, fixture provider, private uploads, cleanup, and fencing | open — unbuilt | Reproducible container/CI, validator, cancellation/retry/crash-recovery, and safe-observability evidence |
| E6 | Paid hosted proof: worker-only provider key, one real job, separate cancel/retry, private render/sync, exact-SHA preview, Sentry review | open — unbuilt | Current official-provider-doc decision record plus hosted validation with no PII |
| Arena gate | Envoy Arena | blocked — unbuilt | At least **eight validated, selectable original identities**, then a separate Arena vertical-slice acceptance record |

## Binding guardrails

- Appearance is independent from Focus, Intel, and Ask capability and authority.
- Envoys can surface truthful status and exact links; they cannot approve or
  execute financial, provider, or other side-effecting actions.
- Legacy Mascot is the rollback path until the new host has verified parity.
- The 2026-07-19 removal is historical context, not an implementation baseline:
  no prior Envoy code or assets are credited toward these rows.
