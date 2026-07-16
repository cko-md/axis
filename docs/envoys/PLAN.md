# Axis Envoys — executable plan

- Status: active
- Owner program: Phase 15
- Quick controls: Interface Studio
- Full management: Control Room → Envoy Lab
- Source of truth: `docs/axis-redesign/15-vector-arcade-and-envoys.md`

## Product contract

An Envoy is Axis appearance, not AI authority. `activeEnvoyId` selects visual
identity. Focus, Intel, and Ask select capability. Clicking the Envoy opens real
work status first; capability tabs remain directly accessible and never require
speaking through a character.

## Legacy parity matrix

| Existing behavior | Required Envoy behavior |
|---|---|
| Axiom Focus brief/chat and local Focus text | Focus remains independent; existing text migrates without upload or loss |
| Codex Intel suggestions and safe navigation | Intel remains independent; route actions use an internal allowlist |
| Nova Ask quick inquiry | Ask remains independent with abort/error parity |
| Modal focus trap, Escape, focus restoration | Preserved and covered by keyboard tests |
| Context label from route | Derived from shared navigation registry; `/tasks`, `/approvals`, `/vector`, games, and Envoy Lab explicit |
| Privacy disclosures | Preserved, updated for private asset/job behavior |
| show/hide | Preserved as `envoyPresence` |
| `monolith | deck | nova` preference | Pure versioned migration to stable starter IDs |

Legacy `Mascot` remains until parity passes. Removal and authoritative EnvoyHost
switch occur together. Preference writes preserve unknown outer-envelope fields,
including browser timezone, and stop after remote-load failure until retry.

## Component boundaries

```text
src/components/envoys/
  EnvoyHost.tsx
  EnvoySprite.tsx
  EnvoyStatusHud.tsx
  EnvoyPanel.tsx
  EnvoyPicker.tsx
  EnvoyGenerationPanel.tsx
  EnvoyLab.tsx
```

`AppShell` dynamically imports `EnvoyHost`. `EnvoySprite` consumes the same
validated `pet.json` + `spritesheet.webp` contract for bundled and generated
Envoys. Status, capability tabs, asset selection, and generation stay separate.

## Truthful active-work projection

One authenticated endpoint returns:

- every nonterminal agent task;
- active/waiting routine runs even when older than recent-history limits;
- current run step and real `complete / total` only when total is known;
- linked pending/approved approval metadata;
- exact wait reason from validated context or status;
- result/deep-link target when persisted;
- source timestamps and section-level degradation.

Ranking is deterministic: waiting-for-user/approval, failed/blocked, executing,
research/calculation, queued, then most recently updated. User can switch among
multiple active items. Realtime accelerates refresh; bounded polling confirms
truth and recovers dropped events.

No missing query becomes `idle`. Partial failure renders `Sync error` for that
section and emits safe metadata. No raw objective, prompt, task detail, or model
content enters Sentry.

Every task state has a pure presentation mapping. Percent is absent unless a
real denominator exists. Approval CTA opens exact review record; it never
approves, executes, or resumes inline.

## Deep links and transition integrity

- `/tasks?task=<uuid>` selects exact task.
- `/tasks?run=<uuid>` selects exact run.
- `/approvals?approval=<uuid>` selects exact approval.
- result links use allowlisted internal routes or server-issued same-origin IDs.
- task and approval state changes use expected-state compare-and-set/RPC and
  return `409` on stale writes.
- approval-gated resume consumes approval only with retry-safe execution state.

## Starter Envoys

Initial concept seeds:

1. **Atlas** — panther cartographer/strategist, restrained field jacket, brass
   navigation instrument.
2. **Morrow** — raven archivist/research scout, layered feather and index-paper
   motifs.
3. **Aster** — luna-moth astronomer, subtle constellation wing structure,
   luminous but never orb-like.
4. **Soma** — cephalopod clinician-engineer, neural filaments and compact tools.

Envoy Arena needs eight shared-registry choices. Four additional original
concepts must pass the same critique before that wave; they are not duplicates,
palette swaps, robots, terminal faces, or caricatures.

Each retained starter includes:

- source prompt and reference provenance;
- `pet.json`;
- horizontal rows for idle, running-right, running-left, waving, jumping,
  failed, waiting, running, and review;
- contact sheet and isolated QA media;
- final compressed `spritesheet.webp` and thumbnail;
- deterministic validation output and hashes.

Small-size readability, clean motion, sophisticated silhouette, originality,
and reduced-motion behavior are rejection gates.

## Two-level customization

Interface Studio contains only:

- active Envoy picker;
- show/hide;
- animation intensity;
- compact state preview;
- selection sync state;
- Manage Envoys link.

Envoy Lab contains:

- full owner library and active selection;
- all-state preview;
- Concept, Surprise Me, and structured brief generation;
- rename, archive, delete, export where safe;
- storage usage, generation history, private reference retention;
- failed-stage retry, cancellation, cleanup state;
- privacy, cost estimate, allowance, and actual usage.

## Generation topology

Browser calls authenticated Vercel APIs. API validates owner, brief, reference
metadata, capability, quota, concurrency, cost reservation, and idempotency,
then returns `202`. It never waits for generation.

Supabase stores durable truth. Render polls and atomically claims jobs. OpenAI
produces canonical reference and referenced state grids. Pinned hatch-pet scripts
extract, normalize, key, align, compose, validate, and package. Private Storage
holds inputs, checkpoints, diagnostics, and final assets. Realtime carries small
metadata events only.

## Durable schema

Planned entities:

- `envoys`
- `envoy_assets`
- `envoy_generation_jobs`
- `envoy_generation_job_events`
- `envoy_worker_heartbeats`
- `envoy_generation_usage`
- private Storage bucket `envoy-assets`

User rows carry `user_id`. Users can read/manage their Envoys and request job
creation/cancellation through narrow RPCs. They cannot directly insert/update
job events, lease fields, attempts, costs, validation, assets, or terminal state.

Service RPCs use fixed `search_path`, explicit grants, database time, and a
lease token/epoch on every mutation. Claim uses `FOR UPDATE SKIP LOCKED` and
sets a unique token. Stale tokens cannot heartbeat, emit, upload-authorize,
retry, complete, fail, or cancel-finalize.

Transactional creation enforces:

- one active job per user by default;
- daily allowance and reserved maximum cost;
- idempotency uniqueness;
- reference count/byte/type limits;
- fail-closed behavior when quota truth is unavailable.

## Job state machine

States:

`queued | leased | preparing | generating_base | generating_states |
validating_states | composing | final_qa | uploading | completed | retry_wait |
cancelling | cancelled | failed`

Transitions are pure and tested. Worker persists state before each expensive
operation. Visible stages derive from state plus durable accepted work units:

1. Getting Envoy ready
2. Imagining Envoy's main look
3. Picturing Envoy's poses
4. Hatching Envoy

Examples of truthful detail: `Base reference generated`, `4 of 9 animation
states generated`, `Waiting for worker`, `Retrying waving state`. No model-made
percentage. Percentage appears only from a fixed manifest denominator.

## Worker contract

Dedicated package under `workers/envoy-hatch/`:

- Node 24 TypeScript process;
- Python plus pinned Pillow/WebP support;
- official OpenAI SDK with `maxRetries: 0` and explicit abort timeout;
- pinned vendored hatch-pet tools plus upstream commit/license/hash manifest;
- fixture and OpenAI providers behind one interface;
- production guard that makes fixture provider impossible to enable;
- fresh `mkdtemp` workspace, path-containment assertions, validated private
  object keys, and `spawn`/`execFile` argument arrays only;
- no `--force`, interpolated shell, user-authored path, arbitrary command, or
  dynamic `latest` download;
- accepted expensive outputs privately checkpointed with hashes before advance;
- bounded per-stage retry; successful stages are reused after crash/reclaim;
- cancellation checks between work units;
- temp and unreferenced staging cleanup with observable retry.

Independent worker heartbeat includes release, supported capability version,
vendored upstream commit, provider state, and safe health code. Vercel disables
new jobs when heartbeat is stale or incompatible. Idle workers still heartbeat.

## OpenAI and QA contract

Current official docs must be consulted immediately before implementation.
OpenAI key remains worker-only where practical. App owns retries and persists an
attempt before each request. Safe request IDs, status, model, stage, duration,
coarse usage, and outcome may be recorded. Prompts, references, local paths,
image bytes, provider bodies, and raw exceptions may not be logged.

Pipeline:

1. normalize prompt into a structured brief; user text remains data;
2. moderate and validate brief/references;
3. create canonical base reference;
4. create API-safe 2D staging grids for state cells;
5. deterministically extract, discard unused cells, remove chroma key, normalize
   to 192×208, align baseline, and compose upstream horizontal rows;
6. run deterministic validators;
7. run three stateless blind vision reviews on randomized unlabeled sheet;
8. compute consensus with upstream-compatible tooling;
9. run separate labeled final QA with strict structured output;
10. package only when deterministic and review gates pass.

Deterministic invalidity always fails. Retry only failed base/state within
reserved attempts. Exhaustion leaves private diagnostics and exposes Retry
Failed Stage; it never publishes a partial Envoy.

Cost estimate derives from actual prepared manifest: base, nine standard rows,
cardinal strip, coherent look rows where required, retries, input-image usage,
three blind reviews, final QA, and artifact bytes. Reservation reconciles to
actual usage.

## Private asset and retention contract

Runtime receives short-lived signed URLs for `pet.json`, spritesheet, and
thumbnail only. References, prompts, grids, individual rows, QA sheets, logs,
and diagnostics remain private management artifacts. Realtime never contains
base64 or signed asset payloads.

Cancelled/failed staging artifacts follow a bounded retention window. User can
choose reference retention. Delete queues private cleanup; failed cleanup stays
visible/retryable. No public bucket is allowed.

## API surface

- `GET /api/envoys`
- `POST /api/envoys/generate`
- `GET /api/envoys/capabilities`
- `GET /api/envoys/status`
- `GET /api/envoys/generation-jobs/[id]`
- `POST /api/envoys/generation-jobs/[id]/cancel`
- `POST /api/envoys/generation-jobs/[id]/retry-stage`
- `PATCH /api/envoys/[id]`
- `POST /api/envoys/[id]/select`
- `DELETE /api/envoys/[id]`
- signed private asset endpoint(s)

All routes authenticate, derive owner from session, validate with Zod, cap
payloads, check ownership, and expose normalized errors. Generate returns `202`
after durable queueing.

## Completion evidence

Envoy core:

- all legacy preference fixtures migrate;
- selection/show-hide sync across open devices without erasing timezone;
- every task state, multiple active tasks, approval, completion, failure,
  partial sync error, route deep link, and exact-result link pass;
- Focus/Intel/Ask parity, abort, privacy, error, keyboard, focus, and navigation
  pass;
- hidden-tab and game-active idle suspension, reduced motion, low idle CPU, and
  repeated mount/unmount pass.

Generation:

- vendored hashes and deterministic fixture package pass CI;
- worker container proves Node 24, Python, Pillow, and WebP;
- migration applied; grants, RLS, Storage policies, quota races, claim fencing,
  heartbeat, retry, reclaim, cancellation, cleanup, and cross-user isolation pass;
- Render worker healthy;
- real OpenAI job queues quickly, survives browser close, emits stages, validates,
  remains private, renders, selects, and syncs across devices;
- separate live cancellation job passes;
- Vercel preview, Render logs, and post-preview Sentry review pass.

No deployed worker means generation is incomplete, even if local fixtures pass.
