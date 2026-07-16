# ADR 0005 — Offline save, sync, and cache boundary

- Status: accepted
- Date: 2026-07-16
- Wave: 15.0

## Context

Gameplay must never wait for network. Saves need offline mutation, deterministic
reconciliation, cross-device sync, conflict preservation, account isolation,
and schema migration. Per-game installation also needs immutable Next chunks and
assets without caching authenticated pages, APIs, RSC, or private content.

## Options considered

1. Supabase-first writes with local fallback — simple server truth, but gameplay
   blocks or loses writes offline.
2. `localStorage` snapshots plus background sync — insufficient transactions,
   size, indexing, migration, ownership, and outbox durability.
3. Owner-partitioned IndexedDB plus idempotent outbox, owner-RLS Supabase sync,
   and a separate allowlist-only Cache Storage worker.

## Decision

Use option 3. One typed IndexedDB database stores profiles, saves, outbox,
conflicts, install records, and metadata under an explicit owner key. Supabase
stores owner rows through authenticated, schema-validated APIs. Merge policies
vary by data type; incompatible campaign edits preserve both branches.

One root `/sw.js` caches only build-manifested immutable chunks and public game
assets. It never intercepts API, Supabase, auth, HTML navigation, RSC, private
Envoy assets, or opaque third-party traffic. Per-game installs stage, verify,
and atomically promote a complete cache version.

## Rationale

IndexedDB provides transactional local truth; Supabase provides durable
cross-device truth; Cache Storage holds public executable/art assets only.
Separating these roles prevents private-save leakage through the worker and
keeps gameplay independent from connectivity.

## Consequences

- Sign-in/sign-out and anonymous merge become explicit lifecycle events.
- Save versions require ordered pure migrators and corrupt-data quarantine.
- Build must emit deploy-specific game manifests for hashed chunks.
- Service-worker upgrade tests must include an older root worker and legacy
  Workbox caches.

## Reversal cost

Medium. IndexedDB records can be exported/migrated, and Supabase tables are
additive. Service-worker rollback must retain the prior complete cache until a
replacement activates safely.
