# VECTOR Arcade — executable plan

- Status: active — shared platform delivered; all nine games remain planned
- Owner program: Phase 15
- Primary route: `/vector`
- Game route: `/vector/[game]`
- Source of truth: `docs/axis-redesign/15-vector-arcade-and-envoys.md`

## Product contract

VECTOR is an Axis module, not a separate arcade skin. It inherits theme, accent,
surface tone, radius, type, density, and resolved motion preference. Stronger
retro-futurist character comes from instrument geometry, spatial hierarchy, and
mechanic-relevant art—not fake CRT noise, illegible pixel type, or dead switches.

Every enabled tile supports a complete `Play | Resume | Restart | Install
Offline | Remove Offline` flow where applicable. Planned games remain clearly
labelled and disabled until their wave passes all completion gates.

## Delivered platform baseline

Wave 15.2 delivers the shared lobby, route-safe serializable registry, isolated
runtime host, owner-partitioned IndexedDB repository, compare-and-set local and
cloud saves, profile/event merge policies, conflict preservation and explicit
resolution, migration quarantine/retry, bounded authenticated APIs, additive
RLS schema, and allowlist-only protocol-v3 offline installation. The lobby is
truthful: every game remains disabled and labelled `Planned` until its own wave
ships an interactive vertical slice and compatible loader.

## Selected console direction

Three concepts are reviewed in Wave 15.0:

1. **Instrument Deck** — featured viewport plus compact library rail, restrained
   brass/bone instrumentation, operational metadata, high information clarity.
2. **Archive Console** — dense grid with slide-over detail, strongest browsing
   efficiency but weaker featured-game theatre.
3. **Panoramic Bay** — wide cinematic preview with lower control rail, strongest
   atmosphere but poor small-screen scaling.

Selected: **Instrument Deck**. Desktop uses featured viewport plus library rail;
mobile becomes one linear flow with sticky, real actions. Card system A uses a
mechanic crop with a separate DOM metadata plate. Card system B uses compact
save-slot strips for Continue/conflict/offline state. Titles and small copy are
always DOM text.

## Registry split

`registry.ts` contains serializable metadata only. `loaders.ts` contains dynamic
client import functions. This stops registry consumers, navigation, metadata,
tests, and lobby rendering from importing game code.

Required manifest fields:

- stable slug, title, short description, version, save-schema version;
- status and availability reason;
- cover/preview asset IDs and intrinsic dimensions;
- capability labels for keyboard, pointer, touch, and gamepad;
- orientation/aspect guidance and minimum viewport;
- engine family (`canvas2d | three`), target frame rate, reduced-motion behavior;
- local/cloud save support, deterministic seed support, score/achievement model;
- offline asset ID list, estimated installed bytes, update compatibility;
- structured controls and accessibility description.

Registry validation rejects duplicate slugs, bad versions, missing assets,
engine/loader mismatch, impossible controls, and enabled games without a loader.

## Shared runtime

One `GameRuntimeHost` owns:

- client-only dynamic load and unsupported-game handling;
- save hydration before start;
- fixed-step clock with elapsed-time clamp;
- start, pause, resume, restart, reset, and visibility suspension;
- bounded autosave plus checkpoint, pause, `visibilitychange`, and `pagehide` save;
- resolved reduced-motion, audio/mute, input, low-power, and gamepad settings;
- scoped focusable input surface, Pointer Events, pointer capture, `pointercancel`,
  blur handling, and play-surface-only `touch-action`;
- WebGL context loss/restoration for Three games;
- safe event reporting with no private save payloads;
- idempotent disposal of RAFs, timers, listeners, observers, workers, audio,
  geometries, materials, textures, scenes, renderers, and caches.

Two shared engines plus one native lightweight game:

- **Native DOM/Canvas** — Second Sense only; no heavy engine.
- **Phaser** — Brickrise (binding requirement), Time to Fly, Envoy Arena, and
  Phantasy Axis.
- **Three.js** — Paper Glider, Biome Lab, MiniTown, and Neon Rift.

Phaser and Three remain route-isolated and absent from the lobby network trace.

## Local data model

Use one typed IndexedDB database. No game save enters `localStorage`.

Stores:

- `profiles`: owner, device, settings, unlocks, cumulative counters;
- `saves`: owner, game, slot, game/save version, revision, server revision,
  checksum, seed, compact state, timestamps, sync state;
- `outbox`: immutable idempotent events with bounded retry metadata;
- `conflicts`: both incompatible branches plus reason and resolution state;
- `installs`: game/build manifest, cache version, bytes, validation state;
- `meta`: schema version, device ID, last successful sync.

Owner keys are `anonymous:<device-id>` or `user:<uuid>`. Sign-out freezes the
old owner outbox and clears it from memory. Next account cannot query it. Sign-in
offers an explicit anonymous-save merge; decline preserves anonymous data.

Corrupt or unmigratable saves are copied into `conflicts` before any recovery.
Original bytes remain until user resolves or exports them.

## Cloud schema and API

Delivered additive tables:

- `game_profiles`
- `game_saves`
- `game_events`
- `game_scores`
- `game_achievements`
- `game_save_conflicts`

All rows carry `user_id`; owner RLS applies. Browser roles have owner-scoped
`SELECT` only, while mutation is confined to service-role RPC boundaries. API
derives owner from session, validates game/version/bounded JSON with Zod, caps
request, document, row, and bootstrap-response bytes, checks checksum and
monotonic revision, scopes state-bearing bootstrap pulls to one game, and binds
idempotency keys to immutable request fingerprints. `/api/vector` receives both
middleware protection and handler-local auth/ownership checks.

Shared scores are authoritative only where server validation is deterministic.
Other scores are labelled **Unverified personal score** and never shown as a
trusted global ranking.

## Merge policies

- best score: maximum valid score;
- achievements/unlocks: set union;
- cumulative counters: event-derived or monotonic maximum;
- settings: latest explicit edit per field;
- campaign slot: expected-revision compare and set;
- simultaneous incompatible campaign edit: preserve both branches and require
  explicit resolution;
- schema mismatch: ordered pure migrators;
- migration failure: preserve source, set Error, expose export/retry.

Reconnect sequence: freeze writes into a local transaction snapshot, push
idempotent outbox, pull server revisions, merge deterministically, persist
acknowledgements, then report `Synced | Pending | Conflict | Error | Local Only`.

## Offline installation

One reviewed `/sw.js` serves the former root worker URL. Activation removes
known legacy caches. Fetch handling is allowlist-only:

- same-origin immutable `/_next/static/` chunks named in a signed/build output;
- public `/vector-assets/` covers, audio, models, textures, and fonts named in
  the per-game manifest;
- one public minimal offline document.

Never cache `/api`, Supabase URLs, auth callbacks, RSC requests, HTML navigation,
private/signed Envoy assets, responses with `Set-Cookie`, or opaque third-party
responses.

Build generates protocol-v3 game/build manifests from Next loadable output plus
explicit assets. Install downloads into a staging cache, verifies every response
and declared digest/size, then atomically marks it current. Failed update leaves
the prior cache usable. UI shows estimate, installed bytes, update, removal,
quota, and pending saves.

## Game completion matrix

Each row stays `planned` until a separate wave proves every cell.

| Order | Game | Engine | Binding mechanic evidence | Status |
|---|---|---|---|---|
| 1 | Second Sense | DOM/Canvas | Five hidden-timer reproductions; absolute/proportional score; Easy/Hard; hold or start/stop; solo + deterministic daily; local/cloud best; keyboard/pointer/touch | planned |
| 2 | Brickrise | Phaser | Full-screen responsive platforming, hazards, checkpoints, summit, complete 3–5 minute run, keyboard/touch, nausea-safe camera, persisted checkpoint | planned |
| 3 | Time to Fly | Phaser | Five deterministic seeded levels, fixed draggable orbits, launch/Space, all planets required, stable retry, physics/seed tests | planned |
| 4 | Paper Glider | Three.js | Continuous procedural flight, desktop/mobile controls, rings/score, collision end, speed curve, local/cloud best, WebGL disposal | planned |
| 5 | Envoy Arena | Phaser | Eight shared-registry Envoys, CPU arena, token/growth/spill/leaderboard, moving features, safe 30-second map changes, Moon map, mute/motion | planned |
| 6 | Phantasy Axis | Phaser | Original procedural action RPG, three weapons, creature behaviors, XP/levels/upgrades/build sheet, bounded population, run score | planned |
| 7 | Biome Lab | Three.js | Deterministic ecosystem; every control visibly affects simulation; charts/presets/seed/pause/reset/randomize; bounded sustained load | planned |
| 8 | MiniTown | Three.js | Empty land; zones; construction/occupancy/growth; bounded people/cars; exact shared-block road rule; day/night; Explore mode | planned |
| 9 | Neon Rift | Three.js | Voxel FPS mission/waves, three weapons, health/pickups/score/restart, optional gamepad, readable lighting, GPU/bundle/exit audit | planned |

## Binding title-specific acceptance

The matrix is an index, not a substitute for these complete contracts.

### Second Sense

- present five durations and ask player to reproduce each from memory;
- hide timer during reproduction;
- score both absolute and proportional error;
- Easy and Hard modes;
- responsive press-and-hold or start/stop interaction;
- satisfying, restrained timing feedback;
- solo mode and deterministic daily challenge;
- local best and cloud-synced best;
- optional async challenge link only after base platform is sound;
- keyboard, pointer, and touch;
- no copied Dialed branding, layout, effects, or text.

### Brickrise

- full-screen Phaser 2D platformer;
- ascend a brick building with responsive jump and air control;
- platforms, ledges, hazards, checkpoints, and clear summit;
- complete 3–5 minute initial run;
- keyboard and touch;
- original generated player and environment sprites;
- nausea-safe camera movement;
- fast restart;
- correct collision and checkpoint persistence;
- sophisticated illustration and lighting, not generic pixel assets.

### Time to Fly

- five levels; level N contains N planets;
- planets move only by pre-launch drag and stay on fixed circular orbits;
- launch by button or Space;
- no trajectory preview;
- every planet materially contributes to each valid solution;
- no lives or retry limit;
- retry preserves that level's randomized starting positions;
- new game produces a new deterministic seed;
- appearance, size, and gravity remain consistent across levels;
- larger planets exert stronger force across a larger field;
- gravity depends naturally on strength, distance, and entry geometry;
- fields are visually understandable but uncluttered;
- only a small number of valid solutions per level;
- polished launch, miss, retry, and galaxy-arrival sequences;
- unit tests prove deterministic seeding and gravity math.

### Paper Glider

- continuous 3D flight guided by pointer or touch;
- forgiving arcade movement;
- procedurally assembled rooms; no external level dataset;
- warm afternoon light, clean low-poly art, subtle paper material;
- floating rings increase score;
- wall or furniture collision ends run;
- animated curtains, dust, and loose pages;
- increasing speed;
- score, local best, and cloud sync;
- one-click restart;
- desktop and mobile controls;
- sustained performance and WebGL resource tests.

### Envoy Arena

- choose one of eight original shared-registry Envoys;
- CPU-controlled Envoy competitors in large side-scrolling platform arena;
- glowing Axis tokens and gradual growth up to 3×;
- bump/stomp opponents to spill tokens;
- largest and highest-scoring Envoy leads leaderboard;
- moving platforms, spring pads, shortcuts, hazards, risky token routes;
- map arrangement changes every 30 seconds without corrupting collision state;
- low-gravity Moon map;
- upbeat original music/effects with global mute;
- particles and shake respect reduced motion;
- no duplicate game-only Envoy identity/assets;
- first playable core contains movement, jumping, platforms, tokens, CPU,
  growth, and leaderboard; attacks, power-ups, map changes, and polish follow
  only after that core is genuinely fun.

### Phantasy Axis

- compact top-down action RPG with Game Boy Color-era inspiration and modern
  polish, but original identity/assets;
- procedural world with deterministic generation where practical;
- keyboard and touch movement;
- sword, spear, and wand;
- passive creatures retaliate only after attack; aggressive enemies engage;
- health, stamina, XP, levels, damage, and reward feedback;
- level-up choices and weapon upgrades;
- character sheet and current build;
- continuous monster population with bounded density;
- run-end level and XP leaderboard;
- no protected characters, music, locations, sprites, or UI from references.

### Biome Lab

- deterministic living 3D terrarium with terrain, water, plants, and a few
  simple animal populations;
- rainfall, temperature, terrain height, water level, and species balance;
- every control produces visible immediate changes in plant coverage, water,
  populations, color, or ambient motion;
- compact environment/population trend charts;
- presets, seed control, pause/play, reset, and randomize;
- identical seed and inputs reproduce simulation;
- reads as visual experiment, not corporate scientific dashboard;
- bounded simulation complexity;
- sustained-animation and mobile performance tests.

### MiniTown

- empty starting land;
- Residential, Shop, and Workspace placement;
- automatic roads, visible construction, occupancy, and growth;
- residents have home, workplace, shop, schedule, and destination;
- people walk and cars move;
- hover/tap inspection for buildings and residents;
- click-drag blocks contain one, two, or three buildings;
- one drag creates one shared block;
- roads form only around shared-block exterior, never between its buildings;
- visible day/night cycle with cool nights, warm windows, and streetlights;
- slightly top-down camera, light management burden, and free Explore mode;
- original simple stylized 3D models;
- generate multiple concepts before implementation;
- object pooling and bounded resident simulation.

### Neon Rift

- compact original voxel FPS with cyberpunk atmosphere;
- one polished procedural or modular arena;
- device-appropriate responsive mouse/touch look;
- keyboard controls on desktop and optional gamepad;
- three materially distinct weapons;
- enemy waves or compact mission loop;
- pickups, score, health, and restart;
- original voxel characters/environments;
- strong lighting, readable silhouettes, controlled bloom;
- no multiplayer in initial vertical slice;
- aggressive bundle and GPU-memory review;
- pause and complete disposal on route exit.

No next game wave begins until current game is interactive, tested, reviewed,
repaired, committed, and recorded in program state.

## Per-game gate

For every game:

1. start and hydrate real saved state;
2. keyboard plus promised pointer/touch/gamepad controls;
3. meaningful score/progression and failure condition;
4. pause, restart, and visible errors;
5. deterministic seeds where promised;
6. collision/physics-critical unit tests;
7. checkpoint/autosave/refresh recovery;
8. offline save plus installed offline cold launch;
9. reconnect sync and conflict behavior;
10. mobile and desktop play without console/page errors;
11. sustained animation, hidden-tab pause, and repeated route disposal;
12. reduced-motion and mute behavior;
13. final mechanic-relevant cover art with DOM title/copy;
14. timestamped interactive QA log with viewport, input, flow, result, errors,
    screenshot paths, and repaired/remaining defects.

## Performance gates

- `/vector` lobby network trace contains no Canvas game module or Three.js.
- Each game is a distinct dynamic chunk.
- Existing global and `/command` budgets do not regress.
- Record lobby/per-game first-load JS, long tasks, representative desktop/mobile
  FPS, memory after five enter/exit cycles, IndexedDB latency, sync bytes, and
  cache bytes.
- Target stable 60 fps on capable devices; offer controlled 30 fps low-power
  mode before reducing correctness or readability.

Measured budgets enter `.claude/axis-redesign/PERFORMANCE_BUDGETS.json` only
after baseline builds. Budget increases require written evidence.
