# ADR 0007 — Envoy generation control and execution planes

- Status: accepted
- Date: 2026-07-16
- Wave: 15.0

## Context

A full Envoy generation job spans many image and vision calls, deterministic
hatch-pet scripts, private intermediates, retries, cancellation, and packaging.
It must survive browser closure and serverless timeouts. Users must not mutate
worker state or exceed bounded cost. Stale workers must not write after reclaim.

## Options considered

1. Long Vercel request or Server Action — cannot guarantee long execution,
   durable resume, lease recovery, or browser-close survival.
2. Make/cron/local Codex execution — creates an unowned second critical path and
   depends on external orchestration or developer presence.
3. Vercel authenticated control plane, Supabase durable state/private Storage,
   and Render long-lived worker using one pinned deterministic pipeline.

## Decision

Use option 3. Authenticated users create/cancel through narrow RPC-backed APIs.
Render claims jobs atomically with `SKIP LOCKED`, a unique fencing token, and DB
time. Every mutation requires the current token. Independent heartbeat records
advertise release/capability while idle. Transactional quota and cost reservation
gate creation. Worker runs one vendored hatch-pet version with fixture/OpenAI
providers behind one interface and stores hashed private checkpoints.

## Rationale

This topology gives durable ownership, crash recovery, bounded cost, private
artifacts, and a production execution plane without granting clients worker
authority. Fencing prevents the hardest split-brain failure.

## Consequences

- New additive tables, private bucket, fixed-grant RPCs, generated types, RLS,
  Storage policy, and concurrency tests are mandatory.
- Worker has its own lockfile, Node 24/Python/Pillow container, CI, Render
  blueprint, heartbeat, safe telemetry, and cleanup process.
- OpenAI SDK retries are disabled; state machine owns persisted attempts,
  backoff, cancellation, and cost accounting.
- Program cannot claim completion until Render deployment and a real private
  OpenAI job plus separate cancellation smoke pass.

## Reversal cost

Medium. Vercel and Supabase contracts are provider-neutral; another long-lived
worker host can replace Render if it preserves fencing, heartbeat, artifacts,
state machine, and live validation.
