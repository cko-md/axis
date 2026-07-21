# Envoy Worker — Future Backlog & Design Slices

- **Status:** backlog / design-refinement — **not scheduled**
- **Date:** 2026-07-21
- **Depends on:** Wave 15.6 (generation control plane) + Wave 15.7 (vendored worker) — see
  [`docs/axis-redesign/15-vector-arcade-and-envoys.md`](../axis-redesign/15-vector-arcade-and-envoys.md)
- **Relationship:** these extend the 15.6/15.7 **worker pattern**. None of this is buildable as
  live/paid work until 15.7 lands. The *deterministic* items need only a durable job runner (the
  15.6 control plane + a leased worker shell), **not** the paid image provider.

> **For future sessions:** this file is the canonical home for post-15.16 Envoy-worker ideas.
> It is design-refinement altitude, **not** session-ready — every slice has an *Open design
> questions* block that must be resolved before it becomes a one-session Linear issue. Do not
> promote a slice to `Todo` until (a) 15.6/15.7 exist, (b) the Foundation status below is resolved,
> and (c) the slice's open questions are answered.

---

## The reusable spine

The 15.7 worker gives Axis a **durable, leased, cost-governed, private place to do slow or
expensive work off the hot path**. The presence layer owns the other half: a **truthful,
deep-linked status HUD** (designed in Wave 15.4). Every item below is one variation on a single
shape:

> **worker does the heavy thing → writes owner-scoped truth + emits an event → the presence HUD
> surfaces it honestly, proposing and never executing.**

### Worker properties these lean on

| Property | What it unlocks |
|---|---|
| Long-running, crash-resumable | Anything expensive or multi-step that a serverless function would time out on |
| Pull-based / leased | Fair scheduling, concurrency control, no inbound attack surface |
| Fenced by lease token + DB `now()` | Safe against duplicate/stale execution |
| No inbound URL / no UI | Private by construction; only reaches out to Supabase + providers |
| Cost reservation + quota ledger | Bounded spend for any model-backed feature |
| Owner-scoped writeback + events/Realtime | Async "it's ready" UX with a truthful denominator |
| Heartbeat health table | Observable, honest per-feature status |

---

## Foundation status & risk (READ FIRST)

The whole backlog is named "Envoy," but the Envoy program's status is **unresolved on this branch**:

- The Envoy presence layer (`EnvoyHost`, the 15.4 active-work status HUD, `/envoy` route, hook, art)
  was **removed from the tree on 2026-07-19** when the owner rejected the Envoy visual/UX design.
  `src/components/layout/Mascot.tsx` (mounted in `AppShell`) is currently the **sole retained
  presence system**. There is no `EnvoyHost` or active-work HUD adapter in `src/` today.
- As of 2026-07-21 the owner is leaning toward **Envoy abandoned / "Mascot parity" = no work**,
  recorded on an **unpushed** branch (`chore/nongame-followups`). The canonical
  `docs/axis-redesign/15-completion-matrix.md` on `main` still lists **Envoy core (15.4)** and
  **Production Envoy generation (15.6/15.7)** as `open`. The two sources disagree.

**Implication for this backlog:**

- Every **presence-facing** slice (EW-1, EW-2, EW-3, EW-4, EW-5, EW-6) is **doubly blocked** — on
  15.6/15.7 existing *and* on the Envoy program being revived (or the slice re-keyed onto Mascot or
  whatever presence surface succeeds it). Where a slice says "the HUD," read it as *the Envoy status
  HUD (15.4, currently removed) or its successor presence surface.*
- The **presence-agnostic infra** slices — **EW-9** (cost-governor), **EW-10** (run-repair),
  **EW-7** (enrichment), **EW-8** (sync) — deliver value **regardless of Envoy vs. Mascot**. They
  survive even if Envoy stays abandoned, and should be sequenced first for that reason.

**This is the #1 open question for the backlog.** Resolve the Envoy-vs-Mascot presence decision
before scheduling any presence-facing slice.

---

## Reality check (honesty guardrails)

- **Nothing here is built.** 15.6/15.7 are owner-gated and unimplemented. These are forward ideas.
- **The financial-safety kernel is the hard boundary.** Any item touching money or actions stays
  **propose-only** — surface it, deep-link it, let the user approve. Never autonomous execution.
- **Privacy invariant (wave doc #11).** Personalized prompts, intermediates, and assets stay
  owner-scoped and **never** enter logs or client Realtime payloads.
- **Paid items inherit fixture-first + owner-gated spend.** A model-backed feature ships on the
  deterministic fixture path first; the paid provider is flipped on only with owner authorization,
  and every call is counted against the quota ledger.
- **Truthful status only.** Percent appears only with a real denominator (wave doc #7).

---

## Free vs paid split

- **Deterministic — no model, no per-call spend** (need only a durable job runner):
  EW-7 enrichment/reconciliation, EW-8 rate-limit-aware sync, EW-9 cost-governor, EW-10 run-repair,
  and the *rule-evaluation* core of EW-6 watchers.
- **Model-backed — paid provider, owner-gated:** EW-1 milestone evolution, EW-2 emote packs,
  EW-3 contextual skins, EW-4 async Intel/research, EW-5 briefings (synthesis step), and any
  EW-6 watcher that adds an LLM explanation on top of the deterministic trigger.

---

## Suggested first cut / sequencing

Given the Foundation risk, lead with **presence-agnostic infra** (value even if Envoy stays dead):

1. **EW-9 cost-governor** — generalizes the quota ledger 15.6 already needs; every model-backed
   feature (Intel, Ask, briefings) inherits spend caps + fail-closed behavior. Correct home for the
   bounded, circuit-broken AI calls behind the cron 502 storms. Deterministic, unblocks the rest.
2. **EW-10 run-repair** and **EW-7 enrichment** / **EW-8 sync** — durable-job wins independent of
   the presence decision.
3. Only once Envoy vs. Mascot is resolved: **EW-4 async Intel** → **EW-1 milestone evolution**
   (flagship user-facing payoff) → EW-6 watchers → EW-5 briefings → EW-2 / EW-3 form polish.

---

## Features by lens

### Form — how the presence companion looks, feels, expresses
- **EW-1 · Milestone-driven evolution** — the companion visibly grows on *real* signals. Earned
  reward, not a fake badge.
- **EW-2 · Pre-baked emote packs** — one generated expression set; HUD reacts to live state from
  cache, deterministic and free at runtime.
- **EW-3 · Contextual skins, pre-rendered for offline** — day/night, focus/rest, seasonal variants
  baked ahead; instant, offline, no hot-path call.

### Function — what it can do
- **EW-4 · Async Intel / deep-research jobs** — heavy asks run as durable jobs; survive app close.
- **EW-5 · Scheduled multi-source briefings** — the daily brief assembled in the background.
- **EW-6 · Proactive watchers (propose-only)** — the companion notices, never acts.

### Utility — practical day-to-day value
- **EW-7 · Background enrichment / reconciliation** — the ledger/inbox gets smarter without waiting.
- **EW-8 · Rate-limit-aware integration sync** — robust, quota-respecting sync with honest health.

### Operational capacity — reliability & infra
- **EW-9 · Shared cost-governor** — bounded spend across the whole app.
- **EW-10 · Generalized run-repair** — self-healing durable runs, visible and honest.

---

# Linear-style slices

These follow the repo's [`docs/linear/axis-mvp-issues.md`](../linear/axis-mvp-issues.md)
conventions — the **Toolchain contract**, **Label taxonomy**, and **Status convention** there apply
to every slice below. Two **new proposed labels**: `area:envoy`, `area:worker`. Keys `EW-1…EW-10`
are placeholders until Linear issue IDs exist. All start at status **Backlog**.

> **Altitude note.** Unlike MVP issues, the *Technical scope* sections describe **anticipated
> design**, not confirmed paths — the 15.6 schema and 15.7 worker they target do not exist yet, so
> exact file paths and provider tool slugs would be fabricated. Proposed table/RPC names below are
> derived from the 15.6 schema entities named in the wave doc & completion matrix (jobs, monotonic
> events, Envoys, assets, atomic-claim leases, cost ledger, worker heartbeat), and must be confirmed
> against the real 15.6 migration once it lands. Each slice ends with *Open design questions* that
> must be answered before it is session-ready, and a *Manual-test note* rather than a fabricated
> click-path against non-existent UI.

---

## # [Backlog] EW-1 · Milestone-driven presence evolution

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** form
- **Priority:** P2 · **Suggested status:** Backlog
- **Labels:** `area:envoy` `area:worker` `area:ai` `type:feature` `feature-flag` `review-needed`
- **Suggested assignee type:** Review-needed (paid generation + money-adjacent triggers)
- **Estimated complexity:** L · **Cost profile:** model-backed (paid, owner-gated)
- **Dependencies:** 15.6 control plane; 15.7 worker; 15.5 hatch-pet packages; **EW-9** (cost-governor) recommended; Foundation (presence decision) resolved
- **Blocks / blocked by:** Blocked by 15.6, 15.7, Foundation. Blocks nothing.
- **Suggested branch:** `feat/envoy-milestone-evolution`
- **Suggested PR title:** `feat(envoy): regenerate presence variants on verified milestones`
- **Suggested commit message:** `feat(envoy): milestone-gated variant generation with truthful HUD link`

### Problem
Progress signals in Axis (routine streaks, savings goals, run PRs) have no durable, *earned* visual
reward. Badges are cosmetic and disconnected from real state.

### Current behavior
No generation pipeline exists; the presence companion (Mascot today) has a fixed appearance and no
concept of milestone-driven change. There is no `envoys`/`envoy_assets` table and no worker.

### Expected behavior
When a milestone is *genuinely* met (a real, queryable record), the worker generates a new appearance
variant, stores it privately, and the HUD advances the companion with a status that deep-links to the
exact milestone that caused it. Unmet or reversed milestones never advance appearance.

### User workflow
Hit a real milestone → background generation runs (no blocking UI) → next app open shows the evolved
companion → tap the "evolved because…" status → land on the exact milestone record.

### Why this matters
Turns real progress into a felt, personal reward — the single most emotionally resonant payoff of the
generation investment, and the reason a generated companion beats a static mascot.

### Affected surfaces
Presence HUD; 15.6 control plane (job creation, quota); 15.7 worker (generation); private Storage;
milestone/goal data sources (routines, finance, Strava).

### Cross-module implications
Defines how *any* domain emits a "milestone met" fact the worker can trust — a contract EW-6 watchers
and EW-5 briefings can reuse. Must not couple appearance to Focus/Intel/Ask behavior (wave doc #6).

### Technical scope (anticipated — confirm against real 15.6/15.7)
- **Control plane (Vercel/Supabase):** a milestone-triggered, idempotent job-create path (one active
  evolution job per owner); quota reservation via EW-9; read API for current variant + evolution
  history.
- **Worker (Render):** an `evolve` job type on the existing generation state machine — leased, fenced,
  `maxRetries: 0`, hashed checkpoint after the accepted image, uploads a private package.
- **Schema / DB impact:** additive columns/rows on the proposed 15.6 `envoys` / `envoy_assets` tables
  (variant lineage, triggering-milestone FK); an owner-scoped read RPC; **migration required**
  (numbered, additive, RLS owner-scoped, worker mutations service-role-only with fixed `search_path`).
- **Provider/integration impact:** image provider via the EW-adapter (OpenAI default; swappable);
  milestone sources read-only.
- **Observability:** job lifecycle events (monotonic); Sentry tags `area=envoy op=evolve` with job id
  (never prompt/asset bytes); heartbeat unaffected.

### Guardrails
Milestone denominator must be real (wave doc #7). Assets private (wave doc #11). Paid generation
counted against the ledger and owner-gated. Appearance change never alters capability (wave doc #6).

### Acceptance criteria
- [ ] Evolution fires **only** on a verified milestone record; a heuristic/guess never triggers it.
- [ ] New variant is owner-scoped and private; nothing in logs or client Realtime payloads.
- [ ] HUD status deep-links to the exact triggering milestone.
- [ ] Generation spend is reserved **and** reconciled through the ledger (EW-9).
- [ ] A reversed milestone (e.g. refunded transaction) does not leave a falsely-advanced companion.
- [ ] Migration applies first-time and on replay; RLS/grants read back correct; cross-user isolation holds.
- [ ] `tsc --noEmit`, lint, and the bundle-budget check pass.

### Test & validation strategy
Unit: milestone-eligibility predicate + idempotent job-create. Integration: worker claim→generate→
upload→event with the **fixture provider** (production-impossible), asserting no paid call. RLS matrix:
owner-only read of variants/lineage; worker columns not user-writable. Migration: first-apply + replay
+ forced-failure atomicity. Browser (per VE-RISK-008): authenticated Chromium + mobile WebKit showing
an evolved companion and a working deep link. **Paid live smoke is a separate, owner-run gate**, not CI.

### Deployment validation
- [ ] Vercel preview build succeeds; happy + degraded paths exercised on the preview.
- [ ] Supabase migration applied + read back (owner-gated prod DDL).
- [ ] Render worker healthy; one **fixture** job end-to-end; paid smoke recorded separately by the owner.
- [ ] No new Sentry error on the happy path.

### Open design questions
Which signals qualify as milestones, and who defines the catalog? Evolution *ladder* (fixed stages) vs.
free-form variance? Reversal/rollback policy for a retracted milestone? Interaction with EW-2 expression
consistency across stages?

### Manual-test note
No click-path yet — the presence UI it targets is unbuilt/removed. Author the manual checklist when the
successor presence surface and the 15.6/15.7 pipeline exist.

---

## # [Backlog] EW-2 · Pre-baked presence emote / expression packs

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** form
- **Priority:** P3 · **Suggested status:** Backlog
- **Labels:** `area:envoy` `area:worker` `area:ux` `type:feature` `feature-flag`
- **Suggested assignee type:** Review-needed · **Complexity:** M · **Cost profile:** model-backed (paid, owner-gated)
- **Dependencies:** 15.5 hatch-pet; 15.7 worker; Foundation resolved; EW-1 lineage (recommended, for stage consistency)
- **Blocks / blocked by:** Blocked by 15.7, Foundation. Blocks nothing.
- **Suggested branch:** `feat/envoy-emote-packs`
- **Suggested PR title:** `feat(envoy): generate a cached expression set for live HUD reactions`
- **Suggested commit message:** `feat(envoy): one-time emote pack, deterministic runtime mapping`

### Problem
The HUD reflects real state, but the companion cannot emote to it without a paid call on the hot path,
so it stays static exactly when a reaction would matter.

### Current behavior
No generation; no expression concept. Mascot has no state-driven emote mapping.

### Expected behavior
A one-time generated expression set (e.g. `celebrating` / `concerned` / `thinking` / `idle`) that the
HUD swaps between **instantly from cache**, driven deterministically by real run/approval/job state.

### User workflow
A real run fails → companion shows `concerned` (cached frame, no network) → run recovers → returns to
`idle`. No user action; purely reactive.

### Why this matters
Expressiveness that *reads as real-time* while being deterministic and free at runtime — personality
without per-reaction cost or latency.

### Affected surfaces
Presence HUD; 15.7 worker (batch gen); private Storage; the active-work state feed the HUD already consumes.

### Cross-module implications
Establishes the **state → expression** mapping table the HUD reads; EW-1 evolution must regenerate the
pack per stage so expressions stay on-model.

### Technical scope (anticipated)
- **Control plane:** one-time `emote-pack` job-create; read API for the pack manifest.
- **Worker:** `emote-pack` job type; batch-generates N expressions; uploads a private, offline-cacheable set.
- **Schema / DB impact:** proposed `envoy_assets` rows tagged by expression; a small deterministic
  state→expression map (code or config, not per-user). Migration only if a new asset kind/column is needed.
- **Provider/integration impact:** image provider via adapter.
- **Observability:** batch job events; Sentry `area=envoy op=emote-pack`.

### Guardrails
Runtime mapping is deterministic from real state (no model call to *choose* an expression). Assets
private. Generation gated + ledger-counted. Respect `prefers-reduced-motion` in the swap.

### Acceptance criteria
- [ ] Expression set generated **once** per companion (per EW-1 stage), cached, offline-available.
- [ ] Runtime reaction does **zero** paid calls and is deterministic from HUD state.
- [ ] Each expression maps to a real state; no "random" emoting.
- [ ] Reduced-motion users get a non-animated swap.
- [ ] `tsc`, lint, bundle budget pass.

### Test & validation strategy
Unit: state→expression mapping is total and deterministic. Integration: fixture-provider batch produces
the full set; manifest complete. Browser: HUD shows the correct expression for injected states across
Chromium + mobile WebKit; reduced-motion honored.

### Deployment validation
- [ ] Preview build; injected-state reactions verified on preview.
- [ ] Fixture batch end-to-end; paid smoke owner-run separately.
- [ ] No new Sentry error on happy path.

### Open design questions
Canonical expression taxonomy and count (diminishing returns)? One combined pipeline with EW-3 skins?
How to keep packs on-model across EW-1 evolution stages?

### Manual-test note
Deferred until a presence HUD exists to render reactions.

---

## # [Backlog] EW-3 · Contextual skins pre-rendered for offline

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** form
- **Priority:** P3 · **Suggested status:** Backlog
- **Labels:** `area:envoy` `area:worker` `area:ux` `type:feature` `feature-flag`
- **Suggested assignee type:** Review-needed · **Complexity:** M · **Cost profile:** model-backed (paid, owner-gated)
- **Dependencies:** 15.2 offline-install pattern; 15.7 worker; Foundation resolved
- **Blocks / blocked by:** Blocked by 15.7, Foundation. Blocks nothing.
- **Suggested branch:** `feat/envoy-contextual-skins`
- **Suggested PR title:** `feat(envoy): pre-render day/night and mode skins into the offline cache`
- **Suggested commit message:** `feat(envoy): contextual skin variants via ahead-of-time worker batch`

### Problem
Visual variety by context (time of day, Focus vs. rest, season) would otherwise cost a paid call at
display time and fail offline.

### Current behavior
No generation; no contextual variants; the 15.2 offline-install machinery caches game assets only.

### Expected behavior
The worker bakes a small set of contextual variants ahead of time and installs them into the offline
cache; the client swaps by **local** context (device time, resolved Focus mode) with no network.

### User workflow
Evening, offline → companion shows its night skin automatically → enters Focus → focus skin — all
without a request.

### Why this matters
Ambient richness with **zero** hot-path cost and full offline behavior — reuses the 15.2 verified
install/promote discipline instead of inventing a new caching path.

### Affected surfaces
Presence HUD; 15.7 worker; the 15.2 offline manifest/cache; service worker allowlist.

### Cross-module implications
Contextual assets must ride the **same** deploy-specific immutable manifest + atomic-promote flow
(wave doc rollback posture) so they never partially cache; must not admit API/private data into Cache
Storage (wave doc #52–54).

### Technical scope (anticipated)
- **Control plane:** `contextual-skins` job-create; manifest read API.
- **Worker:** batch-generates the variant set; emits an immutable, hash-verified manifest.
- **Schema / DB impact:** proposed `envoy_assets` rows per context; likely **no** new table. Offline
  manifest generation extends the 15.2 build-time step.
- **Provider/integration impact:** image provider via adapter.
- **Observability:** batch events; Sentry `area=envoy op=contextual-skins`; manifest-completeness check.

### Guardrails
Only allowlisted immutable same-origin assets enter Cache Storage. Prior variant retained until the
new manifest is verified (atomic promote). Reduced-motion respected. Assets private at rest; public
cache holds only non-identifying skin frames (**confirm** privacy classification in design).

### Acceptance criteria
- [ ] Contextual variants install into the offline cache and swap **without network**.
- [ ] Prior variant retained until the new manifest is verified, then atomically promoted.
- [ ] No API/RSC/authenticated/private payload ever enters Cache Storage.
- [ ] Context resolution (time/Focus) is local and deterministic.

### Test & validation strategy
Unit: context→skin resolver. Integration: fixture batch → manifest completeness + hash verify; prior
version retained on failed promote. Offline browser test (VE-RISK-008): airplane-mode swap works;
account-switch does not leak another owner's context state.

### Deployment validation
- [ ] Preview build; offline swap verified on preview.
- [ ] Manifest promote/rollback verified; paid smoke owner-run separately.
- [ ] Service-worker cache audit shows only allowlisted assets.

### Open design questions
Which contexts justify the generation cost? Privacy class of contextual frames (public-cacheable vs.
private-signed)? Merge with EW-2 into one form pipeline?

### Manual-test note
Deferred until a presence HUD + the 15.2 offline path host these variants.

---

## # [Backlog] EW-4 · Async Intel / deep-research jobs

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** function
- **Priority:** P2 · **Suggested status:** Backlog
- **Labels:** `area:envoy` `area:worker` `area:ai` `type:feature` `feature-flag` `review-needed`
- **Suggested assignee type:** Review-needed · **Complexity:** L · **Cost profile:** model-backed (paid, owner-gated)
- **Dependencies:** **EW-9** (cost-governor) strongly recommended; 15.4 Intel/Ask (or successor); 15.7 worker; Foundation resolved
- **Blocks / blocked by:** Blocked by 15.7, EW-9 (recommended), Foundation. Blocks nothing.
- **Suggested branch:** `feat/envoy-async-intel`
- **Suggested PR title:** `feat(envoy): dispatch heavy Intel asks as durable leased jobs`
- **Suggested commit message:** `feat(envoy): async research jobs with truthful status + deep links`

### Problem
Multi-source research / long tool-use Asks risk serverless timeouts and block the request while the
user waits.

### Current behavior
Intel/Ask (in the removed 15.4 design) ran inline on the companion AI route with incomplete abort/error
parity; there is no durable background execution for heavy asks.

### Expected behavior
Heavy Asks dispatch as a leased job; the HUD shows `researching…` **truthfully**; the result deep-links
when done and **survives the user closing the app**. Failure is a typed degraded state, never a
fabricated answer.

### User workflow
Ask a heavy question → HUD shows an in-progress work card → close the app → reopen later → result is
ready and deep-links to sources.

### Why this matters
Removes the timeout ceiling on the most valuable asks and makes long work respect app lifecycle — a
capability inline serverless simply cannot provide.

### Affected surfaces
Presence HUD (work card + deep link); 15.6 control plane (job create/read, quota); 15.7 worker; the
internal AI route allowlist (wave doc VE-RISK-012).

### Cross-module implications
Establishes the **async-ask** job type and the "in-progress work card" the HUD already models
(wave doc #10). Must preserve AbortController parity (VE-RISK-012) and typed degradation.

### Technical scope (anticipated)
- **Control plane:** async-ask job-create (idempotent, quota-reserved via EW-9); status/result read API;
  bounded polling + Realtime acceleration.
- **Worker:** `research` job type; bounded app-level retries; persists attempt before each paid call;
  hashed checkpoint after each accepted expensive result (resumable stages).
- **Schema / DB impact:** proposed `envoy_jobs` + monotonic `envoy_job_events`; result stored
  owner-scoped/private. Migration required.
- **Provider/integration impact:** model provider via adapter + allowlisted internal tools only.
- **Observability:** job/stage events; Sentry `area=envoy op=research` (no prompt/answer bytes);
  degraded-path telemetry.

### Guardrails
All model calls counted against the ledger (EW-9). Typed degraded responses on provider failure (no
silent fallback that hides failure — VE-RISK-012). Abort parity. Prompts/intermediates/results private.

### Acceptance criteria
- [ ] A heavy Ask completes as a background job and is readable after app close/reopen.
- [ ] Status is truthful with a real denominator and deep-links to the result/sources.
- [ ] Provider failure surfaces as a **typed degraded state**, not a fabricated answer.
- [ ] Spend reserved **and** reconciled; abort cancels the job and releases reservation.
- [ ] Migration applies + replays; RLS/isolation verified.

### Test & validation strategy
Unit: async-vs-inline routing threshold; abort→cancel→reservation-release. Integration: fixture-provider
research job with resumable stages; crash mid-job resumes from checkpoint without a duplicate paid call.
RLS: owner-only result read. Browser: work card lifecycle across app close/reopen on Chromium + mobile.

### Deployment validation
- [ ] Preview build; close/reopen persistence verified on preview.
- [ ] Migration applied + read back; fixture job end-to-end; paid smoke owner-run separately.
- [ ] No Sentry regression; degraded path emits tagged event.

### Open design questions
Latency threshold for async vs. inline? Result freshness/expiry + re-run? Tool-use scope for v1?
Concurrency cap per owner?

### Manual-test note
Checklist deferred until the presence HUD (or successor) can render the work card + deep link.

---

## # [Backlog] EW-5 · Scheduled multi-source briefings

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** function
- **Priority:** P2 · **Suggested status:** Backlog
- **Labels:** `area:envoy` `area:worker` `area:ai` `area:integrations` `type:feature` `feature-flag`
- **Suggested assignee type:** Review-needed · **Complexity:** L · **Cost profile:** model-backed (paid, owner-gated)
- **Dependencies:** `axis-daily-run` skill/cron; **EW-9**; **EW-8** (fresh sync) recommended; 15.7 worker; Foundation resolved
- **Blocks / blocked by:** Blocked by 15.7, EW-9, Foundation. Blocks nothing.
- **Suggested branch:** `feat/envoy-scheduled-briefings`
- **Suggested PR title:** `feat(envoy): assemble the daily brief in the background worker`
- **Suggested commit message:** `feat(envoy): scheduled brief with bounded/circuit-broken AI + deep links`

### Problem
The morning brief's multi-source synthesis is slow and provider-dependent; on the hot path it means a
spinner and 502 risk (the cron sweep incidents proved this class of failure).

### Current behavior
`axis-daily-run` exists as a cloud cron (7:00 AM UTC) producing a status report; there is no durable,
circuit-broken worker assembling a per-user brief off the hot path, and cron routes previously 502'd on
partial failure (fixed by bounding AI calls + circuit-breaking).

### Expected behavior
The worker assembles the brief on schedule; the HUD presents a **ready** brief on open, each item
deep-linked to its true source; a slow/failed provider degrades the brief per-section, never 502s.

### User workflow
Open the app in the morning → the brief is already there → tap any line → land on the source (email,
event, activity, transaction).

### Why this matters
"Ready when you arrive" removes the single most common wait, and moves the fragile multi-provider
synthesis into the worker's bounded/circuit-broken, resumable environment.

### Affected surfaces
Presence HUD (brief surface); 15.7 worker (scheduled job); integrations (Mail/Calendar/Strava/finance,
read-only); EW-9 ledger.

### Cross-module implications
Reuses EW-6's/EW-1's "trusted domain fact" contract; benefits from EW-8's fresh sync; must apply the
cron 502 lesson (bound + circuit-break) so a slow provider degrades one section only.

### Technical scope (anticipated)
- **Control plane:** scheduled brief job-create; brief read API; per-section degradation model.
- **Worker:** `briefing` job type; parallel bounded source reads; circuit-breaker per provider; single
  synthesis step (ledger-counted); owner-scoped writeback.
- **Schema / DB impact:** proposed `envoy_jobs`/events + a brief record (owner-scoped, private).
  Schedule/timezone source of truth (reuse phase9 IANA-tz preference). Migration required.
- **Provider/integration impact:** read adapters for each source; model provider via adapter for synthesis.
- **Observability:** per-source + synthesis events; Sentry `area=envoy op=briefing`; circuit-breaker state.

### Guardrails
Bounded AI calls + circuit-break (the cron 502 lesson). Brief content private; never in logs/Realtime.
Real denominators; per-section degradation shown honestly. Synthesis spend ledger-counted + gated.

### Acceptance criteria
- [ ] Brief is pre-assembled and shown **without** a hot-path provider call.
- [ ] A slow/failed source degrades that **section**, never 502s or empties the surface.
- [ ] Each item deep-links to its true source.
- [ ] Synthesis spend reserved + reconciled; schedule respects the user's timezone.
- [ ] Migration applies + replays; owner isolation verified.

### Test & validation strategy
Unit: per-section degradation + circuit-breaker transitions. Integration: fixture sources + fixture
synthesis assemble a brief; one failing source degrades only its section. Timezone: schedule resolves
against the stored IANA tz. Browser: brief renders with working deep links on Chromium + mobile.

### Deployment validation
- [ ] Preview build; degraded-source behavior verified on preview.
- [ ] Migration applied + read back; fixture brief end-to-end; paid smoke owner-run separately.
- [ ] No cron/route 502 regression; no Sentry regression.

### Open design questions
Merge with vs. layer on the existing `axis-daily-run` cron (one scheduler, not two)? Which sources ship
in v1? Per-section vs. whole-brief degradation UX? Retention of past briefs?

### Manual-test note
Deferred until the presence surface can host the brief; validate the worker/degradation logic headless first.

---

## # [Backlog] EW-6 · Proactive watchers (propose-only)

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** function
- **Priority:** P2 · **Suggested status:** Backlog
- **Labels:** `area:envoy` `area:worker` `security` `type:feature` `feature-flag` `needs-human`
- **Suggested assignee type:** Review-needed (kernel-sensitive) · **Complexity:** M
- **Cost profile:** deterministic core (free) + optional model explanation (paid, gated)
- **Dependencies:** financial-safety kernel (approval taxonomy); 15.4 HUD/deep-links (or successor); 15.7 worker **or** a durable job runner; Foundation resolved
- **Blocks / blocked by:** Blocked by durable job runner + kernel; Foundation. Blocks nothing.
- **Suggested branch:** `feat/envoy-watchers`
- **Suggested PR title:** `feat(envoy): propose-only background watchers with deep-linked alerts`
- **Suggested commit message:** `feat(envoy): deterministic watcher rules, propose-only, kernel-safe`

### Problem
Axis has the data to notice things (renewals, anomalies, calendar conflicts) but no background
evaluator that surfaces them **without acting**.

### Current behavior
No watcher subsystem. Any "noticing" today is manual on open. The kernel forbids autonomous action.

### Expected behavior
The worker evaluates **deterministic** rules on a schedule; a match raises a truthful, deep-linked HUD
alert with **approve / dismiss** — never an executed action.

### User workflow
A subscription renews 25% higher → HUD raises "review this renewal" → user opens the exact transaction →
approves a follow-up or dismisses. The system never cancels/pays anything on its own.

### Why this matters
An assistant that *notices* is a step-change in perceived intelligence — but only safe if it stays
strictly propose-only. This slice is the reference implementation of "proactive within the kernel."

### Affected surfaces
Presence HUD (alerts + approve/dismiss); worker (rule evaluation); domain data (finance, calendar,
integrations, read-only); approval kernel.

### Cross-module implications
Defines the **watcher rule** contract and the **alert → approval** handoff. Sets precedent every future
proactive feature must follow: deterministic trigger, deep link, explicit approval. Any LLM explanation
is additive and gated.

### Technical scope (anticipated)
- **Control plane:** watcher registry (owner-scoped rules); alert read API; alert→approval bridge that
  reuses the existing approval RPCs (no new execution authority).
- **Worker (or durable runner):** scheduled deterministic rule evaluation; emits owner-scoped alerts;
  no write path to money/actions.
- **Schema / DB impact:** proposed `envoy_watchers` (rules) + `envoy_alerts` (owner-scoped);
  alerts reference existing task/approval rows for the action path. Migration required; RLS owner-scoped.
- **Provider/integration impact:** read-only domain queries; **optional** model call for a
  human-readable explanation (gated, ledger-counted).
- **Observability:** evaluation + alert events; Sentry `area=envoy op=watch`; alert-rate metric.

### Guardrails
**Kernel: propose-only, never execute.** Approval is an explicit user action through the existing
approval path. Deterministic triggers; any model explanation is additive, gated, private. Owner-scoped.

### Acceptance criteria
- [ ] Triggers are deterministic and owner-scoped; **no** autonomous action is ever taken.
- [ ] Every alert deep-links to the exact record and offers approve/dismiss.
- [ ] The approval path reuses existing kernel RPCs; the watcher grants **no** new execution authority.
- [ ] Optional model explanation is gated + ledger-counted; absent it, the alert still stands on the rule.
- [ ] Alert rate is bounded (no fatigue); migration applies + replays; isolation verified.

### Test & validation strategy
Unit: each rule predicate is deterministic and total; alert dedupe/rate-limit. Integration: seeded data
triggers exactly the expected alerts; **negative test** proves no money/action write path exists from a
watcher. RLS: owner-only rules/alerts. Kernel test: an alert cannot escalate to execution without an
explicit approval.

### Deployment validation
- [ ] Preview build; alert → approve/dismiss verified on preview.
- [ ] Migration applied + read back; **security review** of the propose-only boundary (needs-human).
- [ ] No Sentry regression; alert-rate within bound.

### Open design questions
Rule authoring: fixed catalog vs. user-defined DSL? Alert fatigue controls and grouping? Which domain
ships first (finance vs. calendar)? Where the optional explanation call sits in the ledger.

### Manual-test note
The approve/dismiss UI is presence-dependent; the deterministic rule engine + no-execution boundary can
and should be validated headless first.

---

## # [Backlog] EW-7 · Background enrichment / reconciliation

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** utility
- **Priority:** P2 · **Suggested status:** Backlog
- **Labels:** `area:worker` `area:data` `type:feature` `rls`
- **Suggested assignee type:** Review-needed (money data) · **Complexity:** M · **Cost profile:** deterministic (free)
- **Dependencies:** 15.6 control plane **or** a durable job runner; provider adapter registry (INT); **presence-agnostic**
- **Blocks / blocked by:** Blocked by durable job runner. Blocks nothing. **Not** blocked by Foundation.
- **Suggested branch:** `feat/worker-enrichment-jobs`
- **Suggested PR title:** `feat(worker): background categorize/dedupe/enrich owner data`
- **Suggested commit message:** `feat(worker): idempotent enrichment passes with preserved provenance`

### Problem
Categorization, dedup, and enrichment are expensive to do inline and make the user wait; done cheaply
they make the whole ledger/inbox smarter over time.

### Current behavior
Enrichment (if any) is inline/ad-hoc. No durable batch runner. Provenance discipline exists in the
finance kernel and must be preserved.

### Expected behavior
Batch passes run in the background and write **owner-scoped, provenance-tagged** results; source data is
never overwritten; the ledger/inbox improves incrementally.

### User workflow
Passive — over days, transactions get categorized and duplicates collapse, with every derived value
traceable to its source; nothing blocks the user.

### Why this matters
Compounding quality with zero user wait and **zero per-call spend** (deterministic) — and it's fully
presence-agnostic, so it delivers even if Envoy stays abandoned.

### Affected surfaces
Worker (batch jobs); finance/mail data; provenance model; no presence dependency (results surface in the
existing domain modules).

### Cross-module implications
Sets the **derived-value provenance** contract other slices reuse. Must respect the finance kernel:
deterministic where money is involved; no silent overwrite; visible conflict on failure.

### Technical scope (anticipated)
- **Control plane / runner:** enqueue enrichment passes (idempotent, owner-scoped); progress read API.
- **Worker:** `enrich` job type; batch, resumable, idempotent; writes derived rows with provenance FKs.
- **Schema / DB impact:** additive derived/enrichment columns or side tables with provenance;
  owner-scoped RLS; migration required. **No** destructive rewrite of source rows.
- **Provider/integration impact:** read via adapter registry; deterministic transforms only (any
  model-based enrichment is a **separate**, gated follow-up, not this slice).
- **Observability:** pass events; Sentry `area=worker op=enrich`; conflict counter.

### Guardrails
Deterministic where money is involved; provenance preserved; **source never overwritten**; a failed pass
creates a **visible conflict/error record**, never a silent overwrite (mirrors save-migrator posture).

### Acceptance criteria
- [ ] Enrichment is **idempotent** and owner-scoped, with provenance on every derived value.
- [ ] Source data is never overwritten; conflicts become visible records.
- [ ] Re-running a pass produces no duplicates and no drift.
- [ ] Migration applies + replays; RLS/isolation verified.

### Test & validation strategy
Unit: each transform is pure/deterministic; idempotency key logic. Integration: seeded dataset →
enrichment → provenance intact; re-run is a no-op; a forced failure yields a conflict record, not an
overwrite. RLS: owner-only derived rows.

### Deployment validation
- [ ] Preview build; enrichment idempotency verified on preview.
- [ ] Migration applied + read back; conflict-on-failure demonstrated.
- [ ] No Sentry regression.

### Open design questions
Which enrichments are provably deterministic vs. need a model (→ split to a gated slice)? Backfill vs.
incremental? Reprocessing triggers and cadence?

### Manual-test note
Fully headless-testable; no presence dependency.

---

## # [Backlog] EW-8 · Rate-limit-aware integration sync

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** utility
- **Priority:** P2 · **Suggested status:** Backlog
- **Labels:** `area:worker` `area:integrations` `observability` `type:feature`
- **Suggested assignee type:** Claude / Review-needed · **Complexity:** M · **Cost profile:** deterministic (free)
- **Dependencies:** provider adapter registry + health model (INT project); 15.7 worker **or** durable runner; **presence-agnostic**
- **Blocks / blocked by:** Blocked by durable runner + adapter registry. Blocks nothing. **Not** blocked by Foundation.
- **Suggested branch:** `feat/worker-sync-jobs`
- **Suggested PR title:** `feat(worker): leased, rate-limit-aware integration sync with honest health`
- **Suggested commit message:** `feat(worker): quota-respecting sync jobs + truthful connection health`

### Problem
Long Mail/Calendar/Contacts/Strava syncs are rate-limited and lack a durable, quota-respecting runner
or an honest health surface (audit: health dead-end; half-removed direct adapters shadowing live ones).

### Current behavior
Syncs run in request paths; health is not consistently truthful (a stale row can read "connected" while
401-ing — the I3 dedup issue). No leased, backoff-aware runner.

### Expected behavior
Syncs run as **leased** jobs that respect provider rate limits with backoff; the HUD/Control Room shows
**true** connection health and prompts reconnection when a provider is actually failing.

### User workflow
A provider token expires → health flips to "needs reconnect" (truthfully) → user reconnects → sync
resumes on the next leased run.

### Why this matters
Robust, quota-respecting sync + honest health directly addresses standing audit findings and is fully
presence-agnostic.

### Affected surfaces
Worker (sync jobs); provider adapter registry + health model; Control Room integration surface; heartbeat.

### Cross-module implications
Extends the INT adapter registry rather than forking it; the health model it writes is consumed by the
Control Room today and by EW-5 briefings (fresh data) later.

### Technical scope (anticipated)
- **Control plane / runner:** schedule per-provider sync jobs (leased, fenced); health read API.
- **Worker:** `sync` job type per provider; token-bucket/backoff aware; writes normalized records +
  health/sync-state.
- **Schema / DB impact:** reuse/extend integration health + sync-state tables; owner-scoped RLS;
  migration only if new health/sync-state columns are needed.
- **Provider/integration impact:** through the adapter registry; Composio-wins dedup (per the I3 fix)
  so a live connection is never shadowed by a stale direct row.
- **Observability:** sync events; **heartbeat** carries provider state; Sentry
  `area=integrations op=sync provider=…`; rate-limit/backoff metric.

### Guardrails
Health status is **truthful** (no "connected" while failing). Secrets never surfaced or logged.
Reconnection is user-initiated. Fenced against duplicate concurrent syncs per provider.

### Acceptance criteria
- [ ] Sync respects provider rate limits (backoff) and is **fenced** against duplicate runs.
- [ ] Connection health reflects reality and drives a working reconnect prompt.
- [ ] A stale direct row never shadows a live Composio connection (I3).
- [ ] Secrets absent from logs/Sentry/Realtime; migration (if any) applies + replays.

### Test & validation strategy
Unit: backoff/token-bucket; dedup precedence (Composio wins). Integration: simulated 401 flips health to
"reconnect"; concurrent-run attempt is fenced to one. RLS: owner-only health/records. Secret-scan: no
token in any output.

### Deployment validation
- [ ] Preview build; health-flip + reconnect verified on preview.
- [ ] Migration (if any) applied + read back; duplicate-run fencing demonstrated.
- [ ] No Sentry regression; secret scan clean.

### Open design questions
Reuse vs. extend the existing adapter registry (and how much of INT-* it subsumes)? Per-provider backoff
policy source? Exact health→HUD mapping? Whether direct read adapters get deleted here or in a later pass.

### Manual-test note
Health flip + reconnect is testable in the existing Control Room; no presence dependency.

---

## # [Backlog] EW-9 · Shared cost-governor service

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** operational
- **Priority:** **P1 (first cut)** · **Suggested status:** Backlog (overlaps 15.6; do first)
- **Labels:** `area:infra` `area:ai` `security` `observability` `type:refactor`
- **Suggested assignee type:** Review-needed · **Complexity:** M · **Cost profile:** deterministic (free)
- **Dependencies:** 15.6 quota ledger (this **generalizes** it); Upstash (defense-in-depth); **presence-agnostic**
- **Blocks / blocked by:** **Blocks** the spend-safety of EW-1/2/3/4/5 + EW-6 explanation. Blocked by 15.6 ledger design. **Not** blocked by Foundation.
- **Suggested branch:** `feat/infra-cost-governor`
- **Suggested PR title:** `feat(infra): promote the generation quota ledger to a shared cost-governor`
- **Suggested commit message:** `feat(infra): reserve/reconcile spend ledger consumed by all AI features`

### Problem
15.6 already needs a quota/reservation ledger for generation. Every other model-backed feature (Intel,
Ask, briefings) needs the same. Without a shared governor, spend is unbounded per-feature — the class of
failure behind the cron 502 storms.

### Current behavior
No shared spend authority. In-memory/serverless rate limits cannot enforce concurrency or spend
(VE-RISK-016). The 15.6 ledger, as scoped, would be generation-only.

### Expected behavior
A first-class control-plane service — **reserve → call → reconcile** — with daily quotas, idempotency,
fail-closed creation, and circuit-breaking, **consumed by all AI features**, not just generation.

### User workflow
Invisible when healthy; on quota exhaustion the user sees a truthful "daily limit reached" state, never
a runaway bill or a silent failure.

### Why this matters
Highest-leverage, deterministic, presence-agnostic slice: it makes the cost answer ("does it have to be
paid?") *governed* — spend becomes bounded and observable app-wide, and it's the correct home for the
bounded/circuit-broken AI calls that broke the cron sweep.

### Affected surfaces
Control plane (new shared service); every AI feature (Intel/Ask/generation/briefings); Upstash;
observability.

### Cross-module implications
Becomes the **single** spend authority; 15.6 generation and EW-4/EW-5 must consume it rather than
rolling their own. Establishes the reservation/reconciliation contract for the program.

### Technical scope (anticipated)
- **Control plane:** transactional Postgres ledger (reserve/commit/refund); daily quota; idempotency
  uniqueness; fail-closed creation; circuit-breaker per provider. A typed client all AI paths call.
- **Worker:** consumes the same ledger for generation (`maxRetries: 0`, reserve-before-call,
  reconcile-after).
- **Schema / DB impact:** proposed `ai_cost_ledger` + `ai_quota` (owner-scoped) with service-role
  mutation RPCs (fixed `search_path`, revoked public execute); migration required.
- **Provider/integration impact:** wraps every model provider call site.
- **Observability:** reservation/commit/refund events; Sentry `area=infra op=cost-governor`;
  quota/circuit metrics; **no secrets**.

### Guardrails
Fail-closed on quota exhaustion. Bounded + circuit-broken external calls. Reservations are transactional
and idempotent (a crash cannot double-charge). No secret leakage. Upstash remains defense-in-depth, not
the authority.

### Acceptance criteria
- [ ] Reserve/reconcile is **transactional and idempotent**; a crash never double-charges.
- [ ] Quota exhaustion **fails closed** with a truthful surface, never a runaway bill.
- [ ] Circuit-breaker opens on provider failure and is observable.
- [ ] **At least one existing AI feature is migrated onto it** as proof (not just generation).
- [ ] Ledger RPCs are service-role-only with fixed `search_path`; public execute revoked; RLS verified.
- [ ] Migration applies + replays; `tsc`/lint pass.

### Test & validation strategy
Unit: reserve/commit/refund state machine; idempotency; fail-closed on exhaustion. Integration:
concurrent reservations respect the cap; simulated crash between reserve and commit does not double-spend;
circuit-breaker opens/half-opens/closes. Grant/RLS: service-role-only mutation, public execute revoked.
Migrate one real feature and prove it now fails closed.

### Deployment validation
- [ ] Preview build; exhaustion + circuit-break verified on preview.
- [ ] Migration applied + read back; RPC ACLs read back; **security review** (needs-human) of the
      service-role boundary.
- [ ] No Sentry regression; no secret in any output.

### Open design questions
Per-feature vs. global daily budgets (and precedence)? User-visible budget UX? Exact reconciliation
semantics for partial/streamed responses? Relationship/authority split with Upstash.

### Manual-test note
Fully headless-testable; no presence dependency. Highest priority despite being unglamorous.

---

## # [Backlog] EW-10 · Generalized run-repair

### Linear metadata
- **Project:** Envoy Worker Extensions · **Lens:** operational
- **Priority:** P3 · **Suggested status:** Backlog
- **Labels:** `area:worker` `area:infra` `observability` `type:feature`
- **Suggested assignee type:** Review-needed · **Complexity:** M · **Cost profile:** deterministic (free)
- **Dependencies:** canonical task/routine RPCs (phase9: `1300`/`1302`/`1400`/`1401`); 15.7 lease/crash-recovery semantics **or** a durable runner; **presence-agnostic**
- **Blocks / blocked by:** Blocked by durable runner + phase9 RPCs. Blocks nothing. **Not** blocked by Foundation.
- **Suggested branch:** `feat/worker-run-repair`
- **Suggested PR title:** `feat(worker): re-drive stuck durable runs with lease-fenced repair`
- **Suggested commit message:** `feat(worker): idempotent, kernel-safe run-repair with visible status`

### Problem
Durable task/routine runs can get stuck (crashed step, stale worker); recovery is manual and invisible.

### Current behavior
Stuck-worker recovery exists for the arcade lifecycle (invalidate token, quarantine for operator review)
but there is no general re-driver for arbitrary durable runs, and no user-visible repair status.

### Expected behavior
The worker's lease + crash-recovery semantics re-drive a stuck run **exactly once** (lease-fenced); the
HUD shows the repair happening and its outcome; the repair honors the existing approval/kernel rules.

### User workflow
A routine run stalls → the system re-drives it and the HUD shows "recovering… → recovered" (or a visible
failure) → the user never has to manually poke a stuck run.

### Why this matters
Self-healing durable execution is a reliability multiplier and generalizes the fencing the worker already
needs — presence-agnostic, and it hardens the whole task/routine spine.

### Affected surfaces
Worker (repair driver); durable task/routine/approval tables + RPCs (phase9); HUD status; heartbeat.

### Cross-module implications
Must route **all** repair state changes through the canonical phase9 RPCs (no bespoke transitions);
reuses the arcade's stale-worker/quarantine precedent so a repaired run can't be double-executed.

### Technical scope (anticipated)
- **Control plane / runner:** detect stuck runs (bounded freshness); enqueue lease-fenced repair;
  repair-status read API.
- **Worker:** `repair` job type; claims via unique lease token + DB `now()`; re-drives via phase9 RPCs;
  quarantines on repeated failure.
- **Schema / DB impact:** likely **no** new tables — reuse task/run/approval + lease/heartbeat; possibly
  a repair-attempt/quarantine column. Migration only if a marker column is added.
- **Provider/integration impact:** none direct (re-drives existing run logic).
- **Observability:** repair attempt/outcome events; Sentry `area=worker op=repair`; quarantine metric.

### Guardrails
Repair is **fenced** (no double-execution). Stays within existing approval/kernel rules. **Never**
re-runs a money action unless the original approval is still valid. Repeated failure → quarantine, not a
retry storm.

### Acceptance criteria
- [ ] A stuck run is re-driven **exactly once** (lease-fenced), with visible status.
- [ ] Repair honors approval/kernel constraints; a money action is not re-run without a still-valid approval.
- [ ] Repeated failure quarantines the run for operator review (no retry storm).
- [ ] All transitions go through phase9 canonical RPCs; isolation verified.

### Test & validation strategy
Unit: "stuck" detection per run type; fencing (second claimant rejected). Integration: a seeded stuck run
is repaired once; a concurrent repair attempt is fenced; an expired-approval money run is **not** re-run;
repeated failure quarantines. Grant/RLS: service-role repair path; user cannot invoke it directly.

### Deployment validation
- [ ] Preview build; repair + quarantine paths verified on preview.
- [ ] Migration (if any) applied + read back; double-execution negative test passes.
- [ ] No Sentry regression.

### Open design questions
What defines "stuck" per run type (freshness thresholds)? Which runs auto-repair vs. require human
confirmation (money-touching)? Backoff + give-up/quarantine policy? Operator surface for quarantined runs.

### Manual-test note
Repair logic is headless-testable via seeded stuck runs; the HUD status is presence-dependent and can
follow.

---

## Change log

- 2026-07-21 — Created from an Envoy-worker ideation pass (10 slices across form/function/utility/
  operational). Design-refinement altitude; nothing scheduled.
- 2026-07-21 — Expanded all 10 slices to full repo-issue depth (problem/current/expected/workflow/
  why/surfaces/cross-module/technical-scope/guardrails/acceptance/test-strategy/deployment/open-
  questions). Added **Foundation status & risk** (Envoy presence removed 2026-07-19; Mascot retained;
  program status unresolved) and re-sequenced to lead with presence-agnostic infra (EW-9/10/7/8).
