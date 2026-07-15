# 04 — Target Architecture

## Layered model (adapted to the actual Next.js/Supabase stack)

```
External providers (Plaid, Public, Polygon/Massive, Perplexity, Gmail/Cal, Make/Composio, MCP)
        ↓  provider adapters — src/lib/integrations/*  (provider models never leak into domain)
Ingestion & normalization
        ↓
Canonical domain (typed entities + money as minor units + provenance)  — src/lib/fund/*, src/lib/entities/* (new)
        ↓
Deterministic calculation services  — pure, typed, tested (src/lib/fund/money.ts is the first)
        ↓
Policy & safety kernel  — action classes, per-tool permissions, approvals (new: src/lib/security/*)
        ↓
Task / routine / skill / agent runtime  — durable steps, run history (new)
        ↓
Application services + API/route boundaries  — src/app/api/*
        ↓
Client cache & state  — visible freshness (build on docs/architecture/widget-cache.md)
        ↓
Workspace shell & UI  — AppShell, command palette, unified search, signals, widgets
```

## Boundaries that must stay clean

Provider models ↔ domain models · domain logic ↔ UI · **deterministic
calculation ↔ generative reasoning** · reads ↔ writes · draft ↔ execution ·
client state ↔ server truth · reusable UI ↔ product UI · agent tools ↔ app
internals · routine definitions ↔ routine runs · user memory ↔ inferred memory ·
historical records ↔ mutable current state.

## Action taxonomy (safety kernel — Phase 5)

`READ` (auto within scope) · `DRAFT` (auto, labeled) · `SIMULATE` (auto, shows
assumptions) · `INTERNAL_WRITE` (policy) · `EXTERNAL_COMMUNICATION` (approve by
default) · `FINANCIAL_EXECUTION` (approve + step-up) · `DESTRUCTIVE_ADMIN`
(approve + safeguards). Combinatorial rule: sensitive private data + untrusted
external content + an external comm/execution tool ⇒ mandatory approval.

## Public order boundary (Phase 10)

Public order flow is split into `prepare`, `verify`, and `submit`.
`src/lib/brokerage/publicOrderAdapter.ts` only creates deterministic
`FINANCIAL_EXECUTION` drafts and configuration checks. `/api/brokerage/orders`
does not place live orders: `submit` returns `APPROVAL_REQUIRED` without a
server-side approval execution context and `BROKER_SUBMIT_NOT_ENABLED` when a
client supplies an approval id. A real broker submitter must be called only from
the server-side approval kernel after `isActionable` and fresh step-up.

## Migration strategy — strangler pattern

Add new contracts beside old systems → route one module/flow at a time → keep
compatibility adapters → verify via tests/telemetry → remove legacy after
verification. No high-risk full rewrite. Every wave = one PR, additive-first.

## ADRs

Material decisions recorded under `docs/axis-redesign/adr/`. First:
`adr/0001-deterministic-money.md`.

## Deterministic calculation policy (governs Phase 4)

Money is represented for arithmetic as **integer minor units (cents)**; major
units appear only at display/serialization boundaries. All aggregation flows
through `src/lib/fund/money.ts` (`sumMoney`, `sumBy`, `toMinorUnits`,
`toMajorUnits`, `parseMoney`). AI may explain a computed number; it must never
produce the authoritative value. Financial invariants (no drift, order
independence, non-finite → 0) are enforced by unit tests.
