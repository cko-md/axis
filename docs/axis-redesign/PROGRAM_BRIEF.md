AXIS[CKO] — VECTOR ARCADE + AXIS ENVOYS PROGRAM

You are the principal engineer, product designer, game-systems architect, and
orchestrator for an owner-authorized cross-module program in:

    cko-md/axis

This instruction explicitly invokes the owner-authorized System Redesign
Override in AGENTS.md §2a for the scope described below. A coordinated,
multi-wave branch and cross-module changes are authorized. All security,
privacy, financial-safety, migration, RLS, testing, observability, and
production-readiness requirements remain binding.

Do not stop after producing a plan. Plan, implement, test, visually review,
adversarially review, repair, and continue until the defined program is
complete or a genuine owner decision, unavailable credential, destructive
migration, or external infrastructure blocker prevents progress.

Use an orchestrator ⇄ implementation-subagent ⇄ review-subagent workflow.
Run implementation waves sequentially. Do not allow concurrent agents to edit
the same worktree or run concurrent Next builds against the same `.next`
directory.

The two product workstreams are:

1. VECTOR ARCADE
   A sophisticated retro-console-inspired game platform within Axis containing
   nine original browser games.

2. AXIS ENVOYS
   A complete replacement of the current mascot/presence implementation with
   anthropomorphic, user-customizable visual embodiments that expose real,
   readable background-work status and preserve the useful existing AI
   capabilities.

-----------------------------------------------------------------------
I. MODEL AND OPERATING MODE
-----------------------------------------------------------------------

Use GPT-5.6 Sol with Ultra mode for orchestration and difficult architecture,
visual, debugging, and integration work.

Use subagents for:
- repository reconnaissance
- product and information architecture
- game-engine architecture
- offline/synchronization architecture
- design critique
- implementation of one tightly scoped wave
- adversarial diff review
- accessibility review
- performance review
- security/RLS review
- browser QA

Do not delegate final architectural decisions or final verification. The
orchestrator owns the diff, gates, and completion judgment.

-----------------------------------------------------------------------
II. READ REPOSITORY GROUND TRUTH FIRST
-----------------------------------------------------------------------

Read these before proposing or changing code:

1. AGENTS.md
2. README.md
3. package.json
4. docs/agent-handoff/codex-phase-buildout-prompt.md
5. .claude/axis-redesign/PROGRAM_STATE.json
6. .claude/axis-redesign/PERFORMANCE_BUDGETS.json
7. .claude/skills/axis-system-redesign/SKILL.md
8. docs/axis-redesign/04-target-architecture.md
9. docs/axis-redesign/06-design-system.md
10. docs/DESIGN_HANDOFF.md
11. src/app/globals.css
12. src/components/layout/AppShell.tsx
13. src/components/layout/Mascot.tsx
14. src/components/theme/InterfaceStudioDrawer.tsx
15. src/components/theme/ThemeProvider.tsx
16. src/lib/theme/interface-settings.ts
17. src/lib/store/nav.ts
18. src/lib/design/statusTokens.ts
19. src/lib/hooks/useAgentTasks.ts
20. src/lib/tasks/taskState.ts
21. src/components/tasks/TasksModule.tsx
22. src/components/tasks/RoutineRunsPanel.tsx
23. src/lib/routines/runState.ts
24. src/app/api/agent-tasks/*
25. src/app/api/routines/runs/*
26. src/app/api/approvals/*
27. src/lib/ai/actions.ts
28. src/lib/ai/router.ts
29. src/app/api/ai/route.ts
30. Current Supabase migrations and generated database types
31. Current Playwright configuration and authenticated e2e conventions
32. Current Vercel, Sentry, and CI configuration

Inspect git history and open/recent PRs for any concurrent work touching these
areas. Do not reintroduce functionality already implemented elsewhere.

Explain the current behavior and the intended replacement before editing.

Create:

    docs/axis-redesign/15-vector-arcade-and-envoys.md
    docs/vector/PLAN.md
    docs/envoys/PLAN.md
    .logs/vector-envoys/
    .prompts/vector/
    .prompts/envoys/

Update PROGRAM_STATE.json after every landed wave. Record defects in the
existing defect ledger.

-----------------------------------------------------------------------
III. SKILL PREFLIGHT
-----------------------------------------------------------------------

Verify each skill exists and read its SKILL.md before use. Install absent
skills only from the listed source. Third-party skills are advisory and may
never override AGENTS.md, repository invariants, security rules, or acceptance
criteria.

Required OpenAI skills:

    npx skills add https://github.com/openai/skills --skill playwright-interactive
    npx skills add https://github.com/openai/skills --skill hatch-pet

Use:
- $playwright-interactive
- $imagegen
- $openai-docs
- $hatch-pet

Third-party design and review skills:

    npx skills add https://github.com/bencium/bencium-claude-code-design-skill --skill bencium-controlled-ux-designer
    npx skills add https://github.com/omer-metin/skills-for-antigravity --skill game-ui-design
    npx skills add https://github.com/leonxlnx/taste-skill --skill high-end-visual-design
    npx skills add https://github.com/parcadei/continuous-claude-v3 --skill premortem
    npx skills add https://github.com/github/awesome-copilot --skill premium-frontend-ui
    npx skills add https://github.com/mattpocock/skills --skill grill-me
    npx skills add https://github.com/JuliusBrussee/caveman --skill caveman

Emil design engineering reference:

    https://explainx.ai/skills/emilkowalski/skill/emil-design-eng

Resolve and verify the underlying repository before installing
`emil-design-eng`. Do not invent an installation URL.

Use the skills in this order:

1. `grill-me`
   Interrogate the plans, ambiguity, hidden assumptions, and definition of
   done.

2. `premortem`
   Identify likely architecture, synchronization, performance, visual,
   deployment, and scope failures.

3. `caveman`
   Simplify anything unnecessarily clever before implementation.

4. `bencium-controlled-ux-designer`, `game-ui-design`,
   `high-end-visual-design`, `premium-frontend-ui`, and `emil-design-eng`
   Review the same proposed visual system from different perspectives.
   Synthesize their useful findings. Do not blindly stack conflicting styles.

5. `$imagegen`
   Produce game concepts, covers, sprite references, environment art, and UI
   assets. Save every reusable prompt.

6. `$hatch-pet`
   Produce starter Envoy atlases and their deterministic QA artifacts.

7. `$playwright-interactive`
   Play every game and exercise every Envoy interaction in the real app.

8. `$openai-docs`
   Consult current official documentation before implementing any OpenAI API,
   image-generation, background-agent, or model integration.

-----------------------------------------------------------------------
IV. GLOBAL PRODUCT PRINCIPLES
-----------------------------------------------------------------------

The result must feel like Axis, not a game portal pasted into Axis.

Axis currently uses:
- a dark, cold, premium glass-panel system
- warm bone typography
- precision hairlines
- gold or user-selected accent channels
- cinematic atmospheric depth
- an instrument-panel sensibility
- semantic status colors
- configurable typography, density, surface tone, radius, and theme

VECTOR may have a stronger retro-futurist identity, but it must inherit and
respond to the active Axis:
- theme mode
- accent
- surface tone
- corner radius
- typography selections
- density
- reduced-motion preference

Avoid:
- generic neon-purple AI dashboards
- childish arcade styling
- excessive scanlines or fake CRT distortion
- unreadable pixel fonts
- gratuitous chromatic aberration
- decorative controls that do nothing
- visual assets unrelated to the actual game mechanic
- giant monolithic components
- generic terminal faces, `>_` faces, cute robots, floating AI orbs, or
  repackaged versions of the existing Monolith/Codex/Nova silhouettes
- fake progress percentages
- fake online status
- fake cloud synchronization
- hardcoded “live” data

All external examples are behavioral and product references only. Do not
scrape, copy, decompile, reproduce source code, or copy proprietary art,
branding, audio, maps, character designs, or visual trade dress.

-----------------------------------------------------------------------
V. WORKSTREAM A — VECTOR ARCADE
-----------------------------------------------------------------------

## A. Product identity

Product name: VECTOR ARCADE
Route: `/vector`
Short internal name: VECTOR
Navigation section: Labs initially
Suggested subtitle: “Interactive systems, simulations, and games.”

Create:
- `/vector` — game library and console shell
- `/vector/[game]` — focused game route
- a lightweight game registry
- a shared game runtime contract
- a shared persistence/sync layer
- shared pause, settings, controls, audio, offline, and synchronization UI
- game-specific dynamic chunks

Do not embed every engine and game into the `/vector` lobby bundle.

## B. Console/lobby design

Create an original retro-futurist console informed by:
- premium 1980s/1990s industrial hardware
- field instruments
- cartridge and disc libraries
- understated CRT/phosphor details
- Axis glass, hairlines, depth, and accent tokens

The lobby should contain:

1. Featured display
   - selected game cover or animated preview
   - title, concise mechanic, current save summary
   - Play, Resume, Restart, and Install Offline actions as appropriate

2. Game library
   - cartridge-like or case-like cards
   - visually relevant cover art
   - locally installed state
   - cloud-sync state
   - last played
   - completion/progression where the game actually supports it
   - keyboard, touch, and gamepad capability labels

3. Continue rail
   - recently played games
   - pending local saves
   - synchronization conflicts requiring attention

4. Console utility strip
   - master volume
   - reduced motion
   - controls
   - offline storage
   - sync health
   - full-screen mode

5. Game detail
   - description
   - controls
   - save slots
   - achievements
   - storage estimate
   - offline installation/removal
   - version and save-schema compatibility

Every visible control must work.

Use DOM text over generated cover images. Do not bake game titles or small
copy into AI-generated images.

Generate concept sheets before settling on the final shell. Save prompts and
selected outputs.

## C. Game platform architecture

Create a typed game manifest/registry. It should cover at least:

- id and slug
- title and subtitle
- description
- engine
- current game version
- save-schema version
- cover and preview assets
- orientation
- keyboard controls
- touch controls
- optional gamepad controls
- audio capability
- offline asset manifest
- save support
- achievements
- leaderboard capability
- estimated offline storage
- feature status
- dynamic entry point

Create a shared runtime boundary so every game supports the applicable
lifecycle operations:

- initialize
- hydrate save
- start
- pause
- resume
- serialize
- autosave
- reset
- suspend on page visibility loss
- dispose engine, listeners, audio, timers, workers, and WebGL resources
- recover from WebGL context loss where applicable
- report meaningful game events without exposing private data

Game routes must dynamically import game code with SSR disabled only where
necessary. Keep the lobby bundle lightweight.

Choose engines deliberately:

- React/Canvas or lightweight DOM for Second Sense
- Phaser for 2D arcade/action games where appropriate
- Three.js or a carefully justified React Three Fiber layer for 3D games
- custom deterministic simulation code for Biome Lab
- do not add PixiJS, Phaser, Three.js, and other overlapping engines without
  clear game-level justification
- isolate engine bundles by route
- measure the cost after each engine is introduced

## D. Original launch catalog

Treat the linked examples as inspiration and functional briefs, not source or
asset repositories.

### 1. Second Sense

Working source inspiration:

    https://dialed.gg/time

Build an original time-memory game:
- present five durations
- ask the player to reproduce each duration from memory
- no visible timer while reproducing
- score by absolute and proportional error
- Easy and Hard modes
- responsive press-and-hold or start/stop interaction
- satisfying but restrained timing feedback
- solo mode
- deterministic daily challenge
- local best score
- cloud-synced best score
- optional asynchronous challenge link only after the base platform is sound
- keyboard, pointer, and touch support
- no copied Dialed branding, layout, effects, or text

This is the first game to implement because it validates the registry,
persistence, offline, scoring, and lobby integrations without introducing a
heavy engine.

### 2. Neon Rift

Source inspiration:

    https://developers.openai.com/showcase/rift-vox

Build a compact original voxel FPS with a cyberpunk atmosphere:
- one polished procedural or modular arena
- responsive mouse/touch-look strategy appropriate to device
- keyboard controls on desktop
- optional gamepad support
- three materially distinct weapons
- enemy waves or compact mission loop
- pickups, score, health, and restart
- original voxel characters and environments
- strong lighting, readable silhouettes, and controlled bloom
- no multiplayer in the initial vertical slice
- aggressive bundle and GPU-memory review
- pause and dispose correctly when leaving the route

### 3. Brickrise

Source inspiration:

    https://developers.openai.com/showcase/brick-platformer

Build a full-screen Phaser 2D platformer:
- player ascends a brick building
- responsive jump and air control
- platforms, ledges, hazards, checkpoints, and a clear summit
- a complete 3–5 minute initial run
- keyboard and touch controls
- original generated player and environment sprites
- camera movement that does not induce nausea
- fast restart
- proper collision and checkpoint persistence
- sophisticated illustration and lighting rather than generic pixel assets

### 4. Time to Fly

Source inspiration:

    https://developers.openai.com/showcase/time-to-fly

Build the five-level cosmic gravitational puzzle:
- Level N has N planets
- planets move only when dragged before launch
- each planet is constrained to its fixed circular orbit
- launch by button or Space
- no trajectory preview
- every planet must materially contribute to a valid solution
- no lives or retry limit
- retry preserves the level’s randomized starting planet positions
- a new game produces a new deterministic seed
- planet appearance, size, and gravity remain consistent across levels
- larger planets exert stronger force over a larger field
- gravity depends naturally on strength, distance, and entry geometry
- gravitational fields are visually understandable but uncluttered
- only a small number of valid solutions per level
- polished launch, miss, retry, and galaxy-arrival sequences
- unit tests for deterministic seeding and gravity calculations

### 5. Paper Glider

Source inspiration:

    https://developers.openai.com/showcase/paper-glider

Build a continuous 3D flying game:
- guide a paper airplane with pointer or touch
- forgiving arcade movement
- procedurally assembled rooms
- warm afternoon light
- clean low-poly art direction
- subtle paper material
- floating rings increase score
- collisions with walls or furniture end the run
- animated curtains, dust, and loose pages
- increasing speed
- score and locally persisted best score
- cloud sync
- one-click restart
- desktop and mobile controls
- no external level dataset
- performance and WebGL resource tests

### 6. Envoy Arena

Source inspiration:

    https://developers.openai.com/showcase/codex-pet-arena

Adapt the concept to Axis Envoys:
- choose one of eight original Envoys
- compete against CPU-controlled Envoys
- large side-scrolling platform arena
- collect glowing Axis tokens
- grow gradually up to 3×
- bump or stomp opponents to spill tokens
- largest and highest-scoring Envoy leads the leaderboard
- moving platforms, spring pads, shortcuts, hazards, and risky token routes
- map arrangement changes every 30 seconds
- include a low-gravity Moon map
- changing maps must not corrupt collision state
- upbeat original music and effects with global mute support
- particles and screen shake respect reduced-motion settings
- use generated Envoy assets from the shared Envoy registry
- never duplicate Envoy assets into a separate game-only identity system

Start with movement, jumping, platforms, tokens, CPU competitors, growth, and
leaderboard. Add attacks, power-ups, map changes, and polish only after the
core is genuinely fun.

### 7. Biome Lab

Source inspiration:

    https://developers.openai.com/showcase/biome-lab

Build a deterministic browser ecosystem sandbox:
- living 3D terrarium
- terrain, water, plants, and a few simple animal populations
- rainfall, temperature, terrain height, water level, and species balance
- visible immediate response in plant coverage, water, populations, color, and
  ambient motion
- compact charts for environment and population trends
- presets
- seed control
- pause/play
- reset
- randomize
- reproducible simulation for the same seed and inputs
- feel like a visual experiment, not a corporate scientific dashboard
- bounded simulation complexity
- sustained-animation and mobile performance tests

### 8. Phantasy Axis

Source inspiration:

    https://developers.openai.com/showcase/phantasy-codex-adventure

Build a compact top-down action RPG:
- Game Boy Color-era inspiration with modern polish
- original visual identity and generated assets
- procedurally generated world
- keyboard and touch movement
- sword, spear, and wand
- passive creatures that retaliate when attacked
- aggressive enemies that engage automatically
- health, stamina, XP, and levels
- damage and reward feedback
- level-up choices
- weapon upgrades
- character sheet and current build
- continuous monster population with bounded density
- run-end level and XP leaderboard
- deterministic generation where practical
- do not use protected characters, music, locations, sprites, or UI from the
  referenced games

### 9. MiniTown

Source inspiration:

    https://developers.openai.com/showcase/minitown

Build a cozy observational city simulation:
- empty starting land
- Residential, Shop, and Workspace placement
- automatic roads
- visible construction stages
- occupancy and growth
- residents with home, workplace, shop, schedule, and destination
- people walking and cars moving
- hover or tap inspection for buildings and residents
- click-drag blocks of one, two, or three buildings
- one drag creates one shared block
- roads around block exterior only
- no roads between buildings within a shared block
- visible day/night cycle
- cool nights with warm windows and streetlights
- slightly top-down camera
- light management burden
- free Explore mode
- original simple stylized 3D models
- generate multiple concepts before implementation
- use object pooling and bounded resident simulation

## E. Build order

Build one complete vertical slice at a time:

1. Shared registry, runtime shell, persistence interfaces, and lobby skeleton
2. Second Sense
3. Brickrise
4. Time to Fly
5. Paper Glider
6. Envoy Arena
7. Phantasy Axis
8. Biome Lab
9. MiniTown
10. Neon Rift
11. Cross-game polish, controller support, offline management, achievements

Do not scaffold nine nonfunctional games. Each game must be complete and
playable before the next begins.

-----------------------------------------------------------------------
VI. OFFLINE-FIRST SAVES AND CLOUD SYNCHRONIZATION
-----------------------------------------------------------------------

## A. Core behavior

Gameplay must never wait for the network.

Persist locally first, then synchronize asynchronously.

Prefer IndexedDB through a small, typed abstraction such as Dexie after
reviewing dependency fit. Do not store game saves in localStorage.

Use:
- versioned save snapshots
- a compact append-only local outbox for unsynchronized events
- idempotency keys
- device id
- game version
- save-schema version
- local revision
- last acknowledged server revision
- checksum
- timestamps
- explicit sync state

Save:
- on meaningful checkpoints
- on level completion
- at a bounded autosave interval
- on pause
- on `visibilitychange`
- on `pagehide`

Do not rely exclusively on `beforeunload`.

## B. Supabase design

Design an additive, RLS-protected schema after inspecting current migration
state. A likely shape includes:

- `game_profiles`
- `game_saves`
- `game_events`
- `game_scores`
- optional `game_achievements`

Every row must be user-owned. Validate JSON payloads with Zod and enforce
payload-size limits server-side.

Do not store entire large world states when a seed plus compact deltas can
reconstruct them.

## C. Merge rules

Do not apply one generic last-write-wins rule to every data type.

Use deterministic merge policies:

- best score: maximum valid score
- achievements/unlocks: set union
- cumulative counters: monotonic or event-derived merge
- settings: per-field timestamp or latest explicit edit
- campaign slot: revision-aware merge
- incompatible simultaneous campaign edits: retain both branches and expose a
  conflict-resolution UI
- save-schema mismatch: migrate through explicit versioned migrators
- failed migration: preserve original data and surface the failure

Never silently discard a newer local save.

## D. Offline installation

Implement per-game “Install Offline” rather than automatically caching every
3D game and asset.

Use Cache Storage/service worker support for:
- app shell
- game chunk
- required fonts
- required cover
- required game assets
- minimal offline route

Show:
- estimated storage
- installed state
- update available
- remove offline copy
- storage quota warning
- pending saves

After reconnection:
- flush the outbox
- pull remote changes
- merge deterministically
- show Synced, Pending, Conflict, Error, or Local Only honestly

-----------------------------------------------------------------------
VII. WORKSTREAM B — AXIS ENVOYS
-----------------------------------------------------------------------

## A. Product model

Replace “Mascot,” “Presence Form,” and character-bound AI modes with:

    Axis Envoys

An Envoy is the selected visual embodiment of Axis.

An Envoy is not itself the AI capability. The selected appearance and the
functional mode are independent.

Preserve and improve the existing useful capabilities:

1. Focus
   - current Axiom strategic brief/chat behavior
   - active objective/focus
   - direct, field-advisor interaction

2. Intel
   - current Codex contextual card behavior
   - route-aware recommendations
   - dismiss and refresh
   - actionable navigation

3. Ask
   - current Nova quick-question behavior
   - fast, minimal interaction

These appear as modes or tabs in one coherent Envoy panel. Preserve privacy
disclosures, error states, Sentry capture, keyboard operation, focus trapping,
Escape behavior, abort handling, and route context.

Do not require the user to “talk through a cartoon.” Clicking the Envoy should
first reveal actual task status. AI modes are secondary controls in the panel.

## B. Refactor structure

The existing Mascot component is too broad. Split responsibilities into a
feature directory, for example:

    src/components/envoys/
      EnvoyHost.tsx
      EnvoySprite.tsx
      EnvoyStatusHud.tsx
      EnvoyPanel.tsx
      EnvoyPicker.tsx
      EnvoyGenerationPanel.tsx
      modes/
        FocusMode.tsx
        IntelMode.tsx
        AskMode.tsx

    src/lib/envoys/
      types.ts
      registry.ts
      animation.ts
      statusAdapter.ts
      persistence.ts
      generation.ts
      prompts.ts

Use the repository’s actual conventions after inspection.

AppShell should dynamically load `EnvoyHost`. Remove the old Mascot path only
after migration and parity tests pass.

Provide compatibility migration for existing settings:
- `companion: "monolith"` maps to a sensible default Envoy
- `companion: "deck"` maps to a sensible default Envoy
- `companion: "nova"` maps to a sensible default Envoy
- existing show/hide preference remains respected

Replace the old fixed union with an `activeEnvoyId` or similarly extensible
identifier without corrupting existing `user_preferences`.

## C. Starter Envoys

Use `$hatch-pet` and `$imagegen` to create several original starter Envoys.
They must be radically different from the current monolith, terminal deck, and
orbital-light forms.

Create concept sheets first. Initial concept seeds:

1. Atlas
   - anthropomorphic panther cartographer and strategist
   - poised, restrained, tailored field-jacket silhouette
   - brass neural-map or navigation instrument
   - strategic and precise, not aggressive
   - represents operational planning and capital discipline

2. Morrow
   - anthropomorphic raven archivist and research scout
   - layered feather silhouette, folded-paper and index motifs
   - observant and editorial
   - represents literature, synthesis, and intelligence triage

3. Aster
   - anthropomorphic luna-moth astronomer
   - elegant wing silhouette with subtle constellation/connectivity patterns
   - luminous but not an orb
   - represents theoretical neuroscience, exploration, and quick inquiry

4. Soma
   - anthropomorphic cephalopod clinician-engineer
   - organic neural-filament pattern and compact tool harness
   - highly distinct silhouette
   - represents connectomics, multitasking, and experimentation

These are starting directions, not mandatory final art. Run a visual critique
and retain only concepts that:
- read clearly at small size
- animate cleanly
- remain sophisticated
- avoid robot morphology
- avoid terminal/code-symbol faces
- avoid demographic caricature
- do not imitate Kevin’s physical appearance unless he explicitly supplies
  reference images and requests it
- may use his professional interests and product context, but not infer or
  visually encode sensitive personal attributes

Use the hatch-pet state contract where relevant:
- idle
- running-right
- running-left
- waving
- jumping
- failed
- waiting
- running
- review

Preserve `pet.json`, source prompts, contact sheet, QA media, and final
spritesheet. Adapt the runtime to Axis without damaging the validated atlas.

## D. Real background-status behavior

The current critique to solve is not merely visual. The Envoy must explain what
Axis is doing.

Use the existing durable task and routine state as the source of truth:
- queued
- gathering_data
- researching
- calculating
- waiting_for_data
- waiting_for_user
- waiting_for_approval
- executing
- blocked
- completed
- failed
- cancelled

Create a deterministic status adapter. A likely visual mapping:

- no active work → idle
- queued → idle with readable “Queued” label
- gathering_data → running
- researching → running or review, based on actual phase
- calculating → running
- executing → running
- waiting_for_data → waiting
- waiting_for_user → waiting
- waiting_for_approval → waiting with approval CTA
- blocked → failed or dedicated blocked presentation
- failed → failed
- completed → waving or jumping briefly, then idle
- review step → review
- drag/reposition → running-left/right

The sprite alone is insufficient.

Render a compact, readable status HUD containing only real data:
- task objective
- exact status label
- active step, when available
- completed steps / total steps, only if a real denominator exists
- elapsed time, when meaningful
- waiting reason
- number of other active tasks
- sync status
- View Task action
- Review Approval action when required

Never invent a percent complete. Use an indeterminate state when progress is
not measurable.

If multiple tasks are active:
- show the highest-priority actionable status
- show the count of other active tasks
- provide a compact task switcher in the expanded panel

Use realtime subscription, event stream, or a bounded polling strategy based
on existing Axis architecture. Do not continuously hammer the API.

Clicking a completion state should navigate to the result or task record, not
open generic chat.

## E. Animation and performance

The Envoy must remain lightweight:
- use the validated sprite atlas
- cap idle animation to a low frame rate
- pause animation when document visibility is hidden
- avoid a permanent 60 fps requestAnimationFrame loop
- avoid expensive filters and full-screen repaints
- no cursor stutter
- no layout shift
- no runaway timers
- no unnecessary rerender of AppShell
- respect reduced motion
- dispose loaded assets correctly

Measure CPU and memory in the browser during:
- idle
- one active task
- expanded panel
- route navigation
- game running
- hidden tab

## F. Customization placement

Use a two-level UI:

1. Interface Studio
   - quick active-Envoy picker
   - show/hide
   - animation intensity
   - compact preview
   - sync state
   - “Manage Envoys” link

2. Control Room → Envoy Lab
   - full library
   - active Envoy
   - preview all animation states
   - generate new
   - randomize concept
   - rename
   - archive/delete
   - download/export where appropriate
   - storage usage
   - generation history
   - failed-job recovery
   - privacy and cost information

Do not turn the already-long Interface Studio drawer into the entire asset
management application.

## G. Prompted and random Envoy creation

Provide:
- free-text concept prompt
- “Surprise me”
- style preset
- demeanor
- archetype
- silhouette family
- material
- palette
- signature accessory
- random seed
- preview of the normalized generation brief
- explicit Generate confirmation

Random generation should construct a deterministic structured brief from
curated, compatible vocabularies. It must not simply send “make something
random.”

Save reusable prompts.

Add:
- user rate limits
- job quota
- cost ceiling
- cancellation where supported
- moderation
- error visibility
- safe Sentry metadata
- no prompt or generated private asset leakage in logs
- ownership/RLS
- signed asset URLs
- image dimensions and file-size limits

-----------------------------------------------------------------------
VII.H — PRODUCTION HATCH-PET RUNTIME
-----------------------------------------------------------------------

## Binding clarification

The prompt deliberately distinguishes bundled starter-Envoy generation from
in-app generation.

`hatch-pet` is a Codex asset-production workflow that delegates visual
generation and performs deterministic atlas assembly and validation. It is not
a browser-side API that a Next.js component can invoke directly.

The implementation must therefore provide an actual durable worker
architecture. A cosmetic Generate button, a request that remains open inside a
Vercel function, or a permanent “coming soon” feature flag does not satisfy
this program.

For this repository, implement the production execution path rather than
stopping at an unavailable state.

## Mandatory architecture

Use this execution topology:

    Browser
       ↓
    Axis Next.js application on Vercel
       ↓
    authenticated generation API
       ↓
    Supabase durable job record and private reference upload
       ↓
    Render Background Worker
       ↓
    OpenAI Image API + pinned hatch-pet deterministic toolchain
       ↓
    private Supabase Storage
       ↓
    Supabase job events / Realtime
       ↓
    Axis Envoy Lab

The web application is the control plane.

The Render worker is the execution plane.

Supabase is the durable source of truth for:
- jobs
- job events
- leases
- generated Envoys
- asset metadata
- private generated files

Do not run the generation pipeline:
- in the browser
- in a React server component
- in a Server Action
- in a Vercel request that waits for completion
- in an Edge function
- through client-visible OpenAI credentials
- through an arbitrary-shell endpoint

## Why a separate worker is required

A complete Envoy generation can require:
- base-character generation
- multiple referenced image edits
- nine animation-state jobs
- selective retries
- image decoding and normalization
- Python/Pillow processing
- chroma-key removal
- cell extraction
- atlas composition
- deterministic validation
- contact-sheet generation
- motion-preview generation
- model-assisted visual QA
- private asset uploads

The execution environment must survive beyond an HTTP request, maintain a
temporary filesystem, support Node and Python tooling, resume after failure,
and report real progress.

Create a Render Background Worker unless repository inspection finds an
already deployed equivalent with all of those properties. Do not substitute
Make.com or a Vercel cron invocation for the worker.

-----------------------------------------------------------------------
VII.H.1 — PIN AND PACKAGE HATCH-PET
-----------------------------------------------------------------------

Use the official OpenAI `hatch-pet` skill as the upstream source.

Do not dynamically download `latest` during a user generation job.

Create a reproducible synchronization process, for example:

    scripts/sync-hatch-pet.mjs
    workers/envoy-hatch/vendor/hatch-pet/
    workers/envoy-hatch/vendor/hatch-pet/UPSTREAM.md

The synchronization artifact must record:
- upstream repository
- pinned commit SHA
- synchronization date
- included files
- excluded files
- upstream license
- SHA-256 manifest
- any Axis-specific compatibility patches

Pin a reviewed commit. CI must fail if the copied files differ from the
recorded manifest unexpectedly.

Prefer an adapter around upstream scripts over modifying them.

Any unavoidable patch must:
- be narrowly scoped
- be documented in `UPSTREAM.md`
- have a regression test
- be re-evaluated whenever the upstream commit changes

The worker must execute the real deterministic hatch-pet scripts for:
- run preparation
- prompt/manifest creation
- layout-guide creation
- row extraction
- left/right mirroring only when valid
- chroma-key cleanup
- frame validation
- atlas composition
- transparent-pixel normalization
- `pet.json` creation
- contact-sheet generation
- motion-preview generation
- package validation

Do not reimplement those stages in ad hoc frontend code.

-----------------------------------------------------------------------
VII.H.2 — WORKER IMPLEMENTATION
-----------------------------------------------------------------------

Add a dedicated worker package, using repository conventions after inspection.
A likely structure is:

    workers/
      envoy-hatch/
        Dockerfile
        package.json
        tsconfig.json
        src/
          index.ts
          claim.ts
          pipeline.ts
          openai-images.ts
          image-layout-adapter.ts
          hatch-runner.ts
          qa.ts
          storage.ts
          telemetry.ts
        vendor/
          hatch-pet/

Prefer a TypeScript orchestration process so it can share Axis contracts, with
Python installed in the container for the official hatch-pet scripts.

The worker image must include:
- Node 24
- Python 3
- Pillow and the exact dependencies required by hatch-pet
- WebP support
- the pinned skill bundle
- no development-only credentials or repository tokens

Add `render.yaml` or the current Render blueprint equivalent.

The worker command must run a long-lived process that:
1. claims one eligible job atomically
2. establishes a renewable lease
3. updates a heartbeat
4. executes the job state machine
5. checks cancellation between expensive stages
6. records actual events
7. uploads final artifacts
8. marks the job terminal
9. releases the lease
10. claims the next job

A worker crash must not permanently strand a job. Expired leases must be
reclaimable with a bounded retry count.

Use exponential backoff with jitter for transient provider failures.

Do not retry:
- moderation rejection without a revised prompt
- invalid user inputs
- unsupported source files
- deterministic validation failures that require regeneration
- jobs explicitly cancelled by the user

-----------------------------------------------------------------------
VII.H.3 — DURABLE JOB MODEL
-----------------------------------------------------------------------

Inspect current migrations before choosing final names. Add an additive,
RLS-protected schema equivalent to:

### `envoy_generation_jobs`

Required concepts:
- `id`
- `user_id`
- `status`
- `stage`
- `stage_index`
- `stage_total`
- `prompt`
- `normalized_brief`
- `style_preset`
- `seed`
- `provider`
- `image_model`
- `idempotency_key`
- `attempt`
- `max_attempts`
- `worker_id`
- `lease_expires_at`
- `heartbeat_at`
- `cancel_requested_at`
- `started_at`
- `completed_at`
- `error_code`
- `error_summary`
- `created_at`
- `updated_at`

### `envoy_generation_job_events`

Required concepts:
- monotonic sequence number
- job id
- user id
- event type
- safe structured metadata
- created timestamp

### `envoys`

Required concepts:
- user ownership
- display name
- description
- style metadata
- active/archive state
- source job
- artifact version
- pet-contract version
- creation timestamps

### `envoy_assets`

Required concepts:
- Envoy id
- job id
- asset kind
- private Storage path
- MIME type
- byte size
- dimensions
- SHA-256
- created timestamp

Use an atomic database function for job claiming with row locking and
`SKIP LOCKED` semantics or an equivalently safe existing repository pattern.

RLS requirements:
- users may only create/read/cancel their own jobs
- users may only read/manage their own Envoys
- users cannot assign leases or worker status
- the worker uses service-role credentials only in the worker environment
- private asset paths are never made globally public
- signed URLs are short-lived
- cross-user object access tests are mandatory

-----------------------------------------------------------------------
VII.H.4 — JOB STATE MACHINE
-----------------------------------------------------------------------

Create a pure, tested job state machine.

Suggested states:

    queued
    claimed
    preparing
    generating_base
    validating_base
    generating_states
    assembling
    validating_package
    uploading
    completed
    cancel_requested
    cancelled
    failed

Suggested user-facing stages:

1. Getting the Envoy ready
2. Imagining the Envoy’s main look
3. Picturing the Envoy’s poses
4. Hatching the Envoy

These map to the visible hatch-pet workflow.

Progress must be based on completed real work.

Permitted progress examples:
- `Base reference generated`
- `4 of 9 animation states generated`
- `Package validation running`
- `Waiting to retry state: review`

Do not invent a model-generated percentage.

A percentage may be shown only when calculated from known completed work units,
such as:

    completed required visual jobs / total required visual jobs

The UI must distinguish:
- queued
- active
- retrying
- waiting for worker
- cancelling
- cancelled
- failed
- completed

Persist every stage transition before beginning the next expensive operation.

-----------------------------------------------------------------------
VII.H.5 — OPENAI IMAGE GENERATION
-----------------------------------------------------------------------

Use the official OpenAI SDK from the worker.

Keep `OPENAI_API_KEY` server-only and worker-only where practical.

Before implementation, use `$openai-docs` to verify the current:
- recommended GPT Image model
- Images generate contract
- Images edit contract
- accepted input formats
- supported dimensions
- background behavior
- rate limits
- moderation errors
- usage fields
- request-id fields
- organization-verification requirements

The current intended provider is the OpenAI Image API.

Use:
- image generation for the canonical base
- referenced image edits for animation states
- canonical base as an input for every state
- the state-specific layout guide as another input
- user references only after validation and private upload

Keep all prompts stored as job artifacts so a failed state can be reproduced.

Do not send unbounded conversation history.

Do not allow a user prompt to:
- alter the worker command
- choose a filesystem path
- choose arbitrary shell arguments
- choose arbitrary outbound URLs
- modify the hatch-pet scripts
- request secrets
- bypass validation
- change Storage ownership

Treat the prompt strictly as visual data.

-----------------------------------------------------------------------
VII.H.6 — API LAYOUT ADAPTER
-----------------------------------------------------------------------

The upstream hatch-pet contract uses horizontal animation rows with:
- 192×208 cells
- up to 8 frames in one row

The Image API may not support the extreme aspect ratio of the raw row.

Do not request an invalid ultra-wide output and hope the provider accepts it.

Add an Axis image-layout adapter:

1. Determine an API-safe 2D grid for each frame count.
2. Generate an adapted layout guide.
3. Ask the image model for exactly one complete pose per grid cell.
4. Validate that every required grid cell contains one pet.
5. Extract cells deterministically.
6. remove the chroma key
7. normalize each pose into a 192×208 cell
8. preserve scale and baseline consistency
9. compose the cells into the horizontal row expected by hatch-pet
10. pass the normalized row into the upstream validation pipeline

Suggested staging grids:
- 8 frames → 4×2
- 6 frames → 3×2
- 5 frames → 3×2 with one intentionally unused cell
- 4 frames → 2×2

The exact output resolution must:
- satisfy the current Image API constraints
- use dimensions divisible by the required provider increment
- remain large enough for clean downsampling
- avoid unnecessary cost

Unused staging cells must be explicitly defined and discarded. They must not
become transparent atlas frames accidentally.

Add fixture tests that verify:
- cell ordering
- grid-to-row conversion
- no frame duplication
- unused-cell handling
- baseline normalization
- chroma-key removal
- transparent RGB normalization
- deterministic output hashes for fixed fixtures

Do not change the final Codex-compatible atlas contract.

-----------------------------------------------------------------------
VII.H.7 — VISUAL QA AND REPAIR
-----------------------------------------------------------------------

Run both deterministic and model-assisted QA.

Deterministic QA must check:
- expected dimensions
- expected frame count
- flat chroma-key background
- no chroma-key collision inside the pet above tolerance
- no clipped body parts
- one principal connected character component per cell
- no cross-cell overlap
- no empty required cell
- no hidden RGB residue in transparent pixels
- valid `pet.json`
- valid spritesheet dimensions
- file-size limits
- decodable WebP output

Use a current vision-capable model, verified through `$openai-docs`, for
structured visual QA of:
- canonical identity
- pose continuity
- state readability
- visual consistency
- detached artifacts
- accidental text
- duplicated frames
- incorrect travel direction
- poor small-size readability

The QA model returns a schema such as:

    {
      "passed": boolean,
      "identity_consistent": boolean,
      "state_readable": boolean,
      "frame_issues": [...],
      "repair_recommendation": string | null
    }

The model is advisory. Deterministic validators own file validity.

Retry only the failing base or state. Do not regenerate every successful state
after one repairable failure.

Enforce a bounded number of image attempts per state and per job.

On exhaustion:
- retain diagnostic artifacts privately
- mark the job failed
- expose a concise user-facing reason
- provide Retry Failed Stage
- do not silently create a partially valid Envoy

-----------------------------------------------------------------------
VII.H.8 — STORAGE CONTRACT
-----------------------------------------------------------------------

Use private Supabase Storage buckets or private prefixes.

Suggested paths:

    envoy-job-inputs/{user_id}/{job_id}/references/*
    envoy-job-work/{user_id}/{job_id}/diagnostics/*
    envoys/{user_id}/{envoy_id}/pet.json
    envoys/{user_id}/{envoy_id}/spritesheet.webp
    envoys/{user_id}/{envoy_id}/thumbnail.webp
    envoys/{user_id}/{envoy_id}/contact-sheet.webp
    envoys/{user_id}/{envoy_id}/motion-preview.webp
    envoys/{user_id}/{envoy_id}/prompts.json
    envoys/{user_id}/{envoy_id}/manifest.json

Production runtime needs only:
- `pet.json`
- `spritesheet.webp`
- optimized thumbnail

Contact sheets, prompts, diagnostics, and previews remain private management
artifacts.

Apply retention rules:
- failed-job temporary files expire after a documented period
- cancelled-job temporary files are cleaned
- completed-job source references follow a documented user-controlled policy
- deleting an Envoy queues safe asset cleanup
- deletion failures are observable and retryable

Never use a public bucket for user-generated Envoys.

-----------------------------------------------------------------------
VII.H.9 — APPLICATION API
-----------------------------------------------------------------------

Implement authenticated routes equivalent to:

    POST   /api/envoys/generate
    GET    /api/envoys
    GET    /api/envoys/[id]
    PATCH  /api/envoys/[id]
    DELETE /api/envoys/[id]

    GET    /api/envoys/jobs/[id]
    POST   /api/envoys/jobs/[id]/cancel
    POST   /api/envoys/jobs/[id]/retry

    GET    /api/envoys/capabilities

`POST /api/envoys/generate` must:
1. authenticate the user
2. validate and normalize the request with Zod
3. verify worker capability
4. enforce rate and concurrency limits
5. validate reference ownership
6. calculate an idempotency key
7. insert the durable queued job
8. return `202 Accepted` with the job id

It must not wait for the Envoy to finish.

The capabilities route must report honest server-derived states:
- enabled
- worker healthy
- provider configured
- temporarily unavailable
- quota reached
- setup required

Do not infer worker health from a frontend environment variable alone.

-----------------------------------------------------------------------
VII.H.10 — ENVIRONMENT AND DEPLOYMENT
-----------------------------------------------------------------------

Add documented environment variables equivalent to:

Web/Vercel:

    ENVOY_GENERATION_ENABLED
    ENVOY_WORKER_STALE_AFTER_SECONDS
    NEXT_PUBLIC_ENVOY_GENERATION_UI_ENABLED

Worker/Render only:

    OPENAI_API_KEY
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    ENVOY_WORKER_ID
    ENVOY_WORKER_POLL_INTERVAL_MS
    ENVOY_WORKER_LEASE_SECONDS
    ENVOY_MAX_JOB_ATTEMPTS
    ENVOY_MAX_STATE_ATTEMPTS
    ENVOY_IMAGE_MODEL
    ENVOY_HATCH_PET_COMMIT
    SENTRY_DSN

Do not expose service-role or OpenAI credentials through `NEXT_PUBLIC_*`.

Add a worker heartbeat. The web application must disable new generation and
show a real unavailable state when no recent healthy worker exists.

A feature flag is permitted for staged rollout, but production completion
requires:
- worker deployed
- worker heartbeat visible
- OpenAI provider verified
- migration applied
- Storage policies verified
- one complete live Envoy generated from Axis
- final package loaded by `EnvoySprite`
- job survives page refresh
- user receives completion state
- Sentry checked

Do not report the feature complete while the production flag remains disabled
because the worker was never deployed.

-----------------------------------------------------------------------
VII.H.11 — USER EXPERIENCE
-----------------------------------------------------------------------

Envoy Lab’s creation flow must include:

1. Concept
   - prompt
   - optional private references
   - style preset
   - demeanor
   - silhouette
   - material
   - palette
   - signature feature

2. Brief review
   - normalized generation brief
   - chosen seed
   - expected output
   - cost/usage notice
   - confirmation

3. Generation
   - persistent job panel
   - actual hatch stages
   - completed state count
   - cancellation
   - safe navigation away
   - resume after refresh or another device

4. Review
   - idle preview
   - every animation state
   - contact sheet
   - rename
   - activate
   - regenerate failed state where applicable
   - archive/delete

The job continues if the user closes the browser.

Use Supabase Realtime when reliable, with bounded polling fallback.

Do not stream base64 images through Realtime or database rows. Store binaries
in Storage and publish only metadata/state events.

Do not show unvalidated intermediate output as a usable Envoy.

-----------------------------------------------------------------------
VII.H.12 — COST, RATE, AND ABUSE CONTROLS
-----------------------------------------------------------------------

Before creating a job:
- enforce prompt-length limits
- enforce reference count limits
- enforce image dimensions
- enforce MIME allowlist
- decode and inspect files rather than trusting extensions
- strip metadata where appropriate
- reject decompression bombs
- reject arbitrary URLs
- apply per-user rate limits
- apply one active generation job per user by default
- enforce a daily generation allowance
- estimate maximum attempts and cost
- require explicit confirmation

Track:
- image requests
- state attempts
- provider request ids
- input/output usage when returned
- elapsed duration
- total bytes
- final outcome

Do not log raw private prompts, source images, or generated binary content in
Sentry.

Use safe identifiers and coarse failure categories only.

Moderation failures must produce a neutral, actionable message and must not be
retried unchanged automatically.

-----------------------------------------------------------------------
VII.H.13 — TESTING
-----------------------------------------------------------------------

Add unit tests for:
- job state transitions
- illegal transitions
- atomic claiming
- lease expiry and reclaim
- idempotent job creation
- cancellation
- retry classification
- prompt normalization
- random brief determinism
- staging-grid selection
- grid-to-row conversion
- chroma-key selection
- cell extraction
- alpha normalization
- manifest validation
- safe Storage paths
- capability calculation

Add integration tests for:
- authenticated job creation
- cross-user RLS isolation
- reference ownership
- worker claim
- heartbeat
- progress events
- worker restart
- expired lease recovery
- failed-state retry
- completed upload
- deletion cleanup

CI must not spend live image-generation credits.

Provide a fixture provider for CI that:
- returns committed synthetic pose sheets
- exercises the complete deterministic pipeline
- cannot be enabled accidentally in production
- is visibly marked as a test provider

Production readiness requires a separate live smoke test using the configured
OpenAI project.

The live smoke test must verify:
1. job creation returns immediately
2. the worker claims it
3. every real stage appears
4. the browser may be closed and reopened
5. the finished package passes hatch-pet validation
6. assets are private
7. the Envoy renders in Axis
8. the Envoy can be selected and synchronized
9. cancellation works on a separate test job
10. no new Sentry regression appears

-----------------------------------------------------------------------
VII.H.14 — SECURITY REVIEW
-----------------------------------------------------------------------

Threat-model:
- user prompt injection into an agentic skill
- command injection into Python invocations
- path traversal
- malicious image files
- reference URL SSRF
- oversized files
- Storage path guessing
- signed URL leakage
- cross-user job access
- service-role exposure
- worker lease theft
- duplicate job execution
- unbounded regeneration cost
- stale worker capability
- arbitrary outbound network access
- private image logging

The production pipeline must be an explicit state machine that invokes a fixed
allowlist of commands with structured arguments.

Never pass a user-controlled string through a shell command.

Use `spawn`/`execFile` argument arrays or an equivalent safe process API.
Do not use `exec` with interpolated command text.

The user’s visual prompt is data, not authority over the worker.

-----------------------------------------------------------------------
VII.H.15 — OPTIONAL OPENAI SKILLS API INTEGRATION
-----------------------------------------------------------------------

The OpenAI Skills API may be used to upload and version the audited hatch-pet
bundle for hosted-shell experimentation, prompt development, or QA.

It is not required on the critical production path if the pinned local bundle
and deterministic worker are more reliable.

Do not create two competing implementations.

The production source of truth must remain:
- one pinned skill version
- one job state machine
- one artifact contract
- one validation pipeline

The Codex SDK and hosted Skills execution may be used during development or
for controlled internal generation, but a user-facing job must not depend on
an interactive Codex desktop session, a developer’s local machine, or a
logged-in Codex UI.

-----------------------------------------------------------------------
VII.H.16 — COMPLETION GATE
-----------------------------------------------------------------------

The hatch-pet/Envoy-generation feature is complete only when:

- the official hatch-pet deterministic tooling is pinned and reproducible
- the Render worker is deployed
- the database migration is applied
- RLS is verified
- private Storage policies are verified
- the worker heartbeat is healthy
- a real OpenAI-backed job runs end to end
- the job survives browser closure
- actual progress is visible
- cancellation works
- state-level retry works
- the API layout adapter works
- the final atlas passes upstream-compatible validation
- `pet.json` and `spritesheet.webp` load in Axis
- the generated Envoy is selectable
- selection synchronizes across devices
- temporary files are cleaned
- cost and rate limits operate
- build, typecheck, lint, tests, and e2e are green
- Vercel preview is validated
- Render logs are reviewed
- post-preview Sentry review is complete

An honest unavailable state is acceptable only during local setup or a
documented provider outage.

It is not an acceptable substitute for deploying the production worker.

-----------------------------------------------------------------------
VIII. DATA, STORAGE, AND SECURITY
-----------------------------------------------------------------------

Likely additive entities include:

- envoys
- envoy_assets
- envoy_generation_jobs
- game_profiles
- game_saves
- game_events
- game_scores
- game_achievements

Do not accept this list blindly. Inspect existing schema and avoid duplicate
tables.

For every migration:
- additive first
- confirm ordering
- include RLS
- user ownership
- service-role access only where a worker requires it
- no public bucket for private generated Envoys
- size and type validation
- cleanup policy for failed generations
- rollback/forward-fix plan
- update generated database types
- add migration tests where available

Game scores submitted to shared leaderboards must not be automatically trusted.
Use deterministic server validation where practical. Otherwise label them as
unverified personal scores rather than presenting a cheat-vulnerable global
ranking as authoritative.

Never place OpenAI, Supabase service-role, GitHub, or provider secrets in the
browser.

-----------------------------------------------------------------------
IX. DESIGN REVIEW REQUIREMENTS
-----------------------------------------------------------------------

Before implementation, produce:
- three VECTOR lobby concepts
- two game-card systems
- one selected console system
- starter cover-art direction
- Envoy concept sheet
- Envoy status HUD concepts
- Envoy Lab concept
- mobile adaptation
- light-mode adaptation

Then run:
- high-end visual review
- controlled UX review
- game UI review
- premium frontend review
- anti-slop review
- reduced-motion review
- accessibility review

Reject a design if:
- it looks like a separate product
- game covers are generic mood art
- the console metaphor impairs navigation
- text contrast is insufficient
- mobile controls obscure the playfield
- status depends only on color or animation
- the Envoy becomes decorative rather than useful
- the Envoy blocks content or interferes with games
- a “retro” effect lowers readability
- idle animation consumes excessive CPU

-----------------------------------------------------------------------
X. IMPLEMENTATION AND REVIEW LOOP
-----------------------------------------------------------------------

For every wave:

1. Inspect
   - exact files
   - current behavior
   - existing reusable contracts
   - migrations and RLS
   - current tests
   - performance budget

2. Define invariant
   - what must remain true after the wave

3. Write a tight implementation spec
   Include only:
   - objective
   - exact files to read
   - deliverables
   - binding constraints
   - tests
   - required structured output

4. Implementation subagent
   - edits working tree
   - does not commit
   - does not push
   - does not touch production data
   - runs targeted gates
   - reports files, decisions, tests, and concerns

5. Orchestrator review
   - inspect entire diff
   - compare to repository patterns
   - check all UI states
   - check security and RLS
   - check error visibility
   - check cleanup/disposal
   - check performance
   - check keyboard and screen-reader behavior
   - check reduced motion
   - check no duplicated logic

6. Browser review
   Use `$playwright-interactive`.
   Do not rely only on screenshots. Interact with the build.

7. Adversarial review subagent
   Ask it to find:
   - broken flows
   - architecture drift
   - fake progress
   - persistence loss
   - sync races
   - stale closure bugs
   - engine cleanup failures
   - mobile-control failures
   - accessibility defects
   - visual incoherence
   - CPU/GPU regressions
   - unhandled offline states
   - unsafe generated-asset access
   - schema/RLS errors

8. Repair
   Fix every validated defect. Bounce substantial problems back to a scoped
   implementation subagent.

9. Re-run gates independently
   Do not trust the subagent’s report.

10. Update:
   - PLAN
   - PROGRAM_STATE
   - defect ledger
   - logs
   - prompts
   - ADRs
   - test evidence

11. Commit one wave
   Use a descriptive commit.

Repeat until complete.

-----------------------------------------------------------------------
XI. REQUIRED TESTING
-----------------------------------------------------------------------

Minimum gates for every code wave:

    npx tsc --noEmit
    npm run lint
    npm run test

Run:

    npm run build

whenever routes, runtime behavior, dynamic imports, assets, or components
change.

Run relevant public and authenticated Playwright suites.

Add tests for:

Platform:
- registry validation
- unsupported/missing game handling
- dynamic game loading
- engine disposal
- pause/resume
- keyboard focus
- reduced motion
- audio settings
- storage quota errors

Persistence:
- local save
- refresh recovery
- offline save
- reconnect sync
- duplicate event idempotency
- conflicting revisions
- merge rules
- save migration
- corrupt save recovery
- local-to-account merge on sign-in
- sign-out behavior
- RLS isolation

Games:
- starting
- controls
- scoring
- failure
- restart
- pause
- hydration
- deterministic seeds
- collision-critical mechanics
- no console errors
- mobile viewport
- sustained animation

Envoys:
- legacy preference migration
- selection
- hide/show
- status mapping for every task state
- multiple active tasks
- approval CTA
- completed-task transition
- failed/offline state
- Focus/Intel/Ask parity
- generation job states
- private asset access
- keyboard and focus management
- route navigation
- reduced motion
- idle CPU behavior

Use Playwright interactive to visibly verify every game. For each game, capture
a QA log with:
- viewport
- input method
- tested flow
- score/progression
- errors
- screenshot paths
- remaining defects

No game is complete merely because it builds.

-----------------------------------------------------------------------
XII. PERFORMANCE BUDGETS
-----------------------------------------------------------------------

Preserve the existing Axis performance gate.

Add explicit VECTOR budgets after measuring baseline:
- `/vector` lobby must not eagerly load Phaser or Three.js
- each game is its own dynamic chunk
- cover images use optimized formats and dimensions
- generated assets are compressed
- no game loop continues after route exit
- WebGL renderers are disposed
- audio contexts are suspended or closed
- event listeners and timers are removed
- idle Envoy animation remains low-cost
- game and Envoy assets do not inflate `/command`

Measure:
- lobby first-load JS
- per-game first-load JS
- long-task count
- FPS on representative desktop and mobile dimensions
- memory after entering and leaving a game repeatedly
- Envoy idle CPU
- IndexedDB write latency
- sync request size
- offline cache size

Prefer a stable 60 fps on capable devices and a controlled 30 fps low-power
mode over unstable visual excess.

-----------------------------------------------------------------------
XIII. DEFINITION OF DONE
-----------------------------------------------------------------------

VECTOR is complete only when:

- `/vector` is integrated into Axis navigation
- the console/lobby is polished and responsive
- every listed game is genuinely playable
- each game has relevant final cover art
- every game has functional controls, pause, restart, errors, and save behavior
- local saves work without a network
- installed games launch offline
- reconnect synchronizes saves
- conflicts are preserved and surfaced
- no game engine leaks after route exit
- all tested routes have no console errors
- mobile and desktop flows work
- performance budgets pass
- visual review passes

Axis Envoys are complete only when:

- old Mascot functionality has been refactored without losing useful behavior
- starter Envoys are original, anthropomorphic, and non-robotic
- selected appearance is independent from Focus/Intel/Ask mode
- the Envoy displays real background task status
- exact waiting and approval states are readable
- no fake percent completion appears
- clicking status reaches the relevant task/result/approval
- legacy companion settings migrate safely
- quick selection exists in Interface Studio
- full management exists in Envoy Lab
- starter assets are hatch-pet validated
- custom-generation jobs are real or honestly feature-flagged
- generated assets are private and user-owned
- idle behavior does not cause cursor or app stutter
- accessibility and reduced motion pass

Program completion additionally requires:

- typecheck green
- lint green
- tests green
- build green
- e2e evidence
- performance gate green
- migrations verified against the configured target
- RLS reviewed
- Vercel preview validated
- Sentry checked after preview
- docs and PROGRAM_STATE updated
- draft PR opened or updated
- remaining risks explicitly recorded

Do not write “complete” for scaffolded, placeholder, mocked, locally unverified,
or feature-flagged functionality.

-----------------------------------------------------------------------
XIV. FINAL REPORT FORMAT
-----------------------------------------------------------------------

Return:

1. Program status
2. Waves completed
3. Commits
4. Files and architecture added
5. Games completed and browser-tested
6. Envoy functions preserved
7. Starter Envoys generated
8. Offline/cache behavior
9. Cloud-sync behavior
10. Database migrations and applied status
11. RLS/security review
12. Test counts and commands
13. Build and performance measurements
14. Playwright evidence
15. Vercel preview
16. Sentry review
17. Known limitations
18. True blockers requiring owner action
19. PR URL

Never conceal incomplete work behind polished language.

-----------------------------------------------------------------------
XV. REFERENCE MATERIAL
-----------------------------------------------------------------------

Game-workflow guidance:

    https://developers.openai.com/codex/build-skills
    https://github.com/openai/skills/tree/main/skills/.curated/playwright-interactive
    https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet

Game references:

    https://dialed.gg/time
    https://developers.openai.com/showcase/rift-vox
    https://developers.openai.com/showcase/brick-platformer
    https://developers.openai.com/showcase/time-to-fly
    https://developers.openai.com/showcase/paper-glider
    https://developers.openai.com/showcase/codex-pet-arena
    https://developers.openai.com/showcase/biome-lab
    https://developers.openai.com/showcase/phantasy-codex-adventure
    https://developers.openai.com/showcase/minitown

Presence-system feedback:

    https://www.reddit.com/r/codex/comments/1u6nytz/design_thoughts_on_the_pet/

Start now with repository reconnaissance, skill verification, the `grill-me`
requirements pass, and a premortem. Then write the plans and begin Wave 1. Iterate through each wave with review and implementation model / workflow until completed.
