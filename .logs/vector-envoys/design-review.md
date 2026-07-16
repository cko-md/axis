# Wave 15.0 design review

- Date: 2026-07-16
- Scope: VECTOR lobby/card system, Envoy identity/HUD/Lab, desktop/mobile,
  dark/light, motion and accessibility
- Inputs: current Axis design system, design handoff, required prompt, five named
  design-review skills

## Concepts reviewed

### VECTOR lobby A — Instrument Deck

Desktop splits into a large mechanic preview and a narrow game rail. A compact
header carries library/continue/offline controls. Real featured actions sit
below preview. Save, input, sync, score, and install metadata use restrained
instrument plates. Strong Axis fit and clear single primary action.

### VECTOR lobby B — Archive Console

Dense cover grid with sortable/filterable library and a detail drawer. Fastest
for repeat selection and scales well to more games. Weak launch theatre and
risks reading like a media catalog rather than an interactive system.

### VECTOR lobby C — Panoramic Bay

Cinematic full-width mechanic preview with horizontal control rail and carousel.
Strongest atmosphere. Weakest keyboard scan order, mobile adaptation, and
multi-state visibility. Large art surface risks generic mood-art dominance.

### Card system A — Mission Plate

Mechanic-relevant 4:3 image, DOM title/description, real capability chips,
progress/save metadata, and one enabled primary action. Used for featured and
library cards. No fake screws, toggles, meters, or lamps.

### Card system B — Save Strip

Compact row for Continue: thumbnail, game/slot, exact last checkpoint, sync
state, conflict or pending count, and Resume. Used only when a real local/cloud
record exists.

## Starter cover-art direction

Every cover proves a mechanic and reserves a quiet metadata plate for DOM copy:

- Second Sense — tactile timing instrument with hidden interval tension;
- Brickrise — readable vertical platform route, checkpoint, and summit;
- Time to Fly — movable orbit geometry and one launch trajectory;
- Paper Glider — glider threading a procedural architectural room;
- Envoy Arena — shared Envoy scale contest with tokens and changing terrain;
- Phantasy Axis — top-down procedural encounter with three weapon silhouettes;
- Biome Lab — one ecosystem responding visibly to environmental controls;
- MiniTown — shared block, perimeter roads, warm windows, and day/night contrast;
- Neon Rift — readable voxel arena lane, weapon silhouette, and wave pressure.

No generic portraits, starfields, landscapes, logos, title lettering, small copy,
or visual promises absent from gameplay. Final covers are generated and reviewed
only after each game's mechanic exists, so art can depict the real interaction.

## Selected system

Select **Instrument Deck + Mission Plate + Save Strip**.

Why:

- keeps one dominant action and one spatial model;
- inherits Axis instrument-panel character without imitating a cabinet;
- makes sync/offline/conflict truth readable;
- uses mechanic art as evidence, not decoration;
- linearizes cleanly on mobile;
- supports keyboard order without spatial tricks;
- keeps planned games honest and disabled until complete.

## Envoy concepts

Concept sheet uses eight original anthropomorphic silhouettes so Envoy Arena can
later use the same shared registry. First production packages still advance only
after individual hatch-pet validation.

1. Atlas — panther cartographer/strategist; field jacket; brass navigation tool.
2. Morrow — raven archivist/scout; layered feathers; index-paper implements.
3. Aster — luna-moth astronomer; constellation wing structure; soft luminosity.
4. Soma — cephalopod clinician-engineer; neural filaments; compact tool harness.
5. Orin — ibex expedition mechanic; long-horn silhouette; precision field kit.
6. Neri — river-otter logistics navigator; streamlined satchel; route tokens.
7. Vesper — bat acoustic analyst; folded cape-wing silhouette; tuning fork tool.
8. Bront — pangolin materials architect; articulated scale apron; drafting gauge.

Reject any concept that becomes robotic, code-faced, orb-like, childlike,
aggressive, caricatured, unreadable at small size, or too detailed to animate.

## Status HUD concepts

### HUD A — Status ribbon

One line beside sprite: semantic status, objective excerpt, step/count when real,
and exact CTA. Efficient but too cramped for wait reasons and degradation.

### HUD B — Work card

Compact popover opened from Envoy: selected task, semantic status, real detail,
elapsed/update time, Sync error when degraded, switcher for other active tasks,
exact record CTA, then Focus/Intel/Ask tabs. Selected.

### HUD C — Ambient badges

Multiple badges around sprite. Rejected: status becomes decorative, spatially
unstable, and color/motion dependent.

## Envoy Lab concept

Three zones:

1. owner library and active selection;
2. state preview and identity details;
3. generation/history drawer with four explicit stages: Concept, Brief review,
   persistent Generation, Review.

Job cards show database states, known work counts, allowance/cost, private input
retention, cancellation, and failed-stage retry. No modal traps generation; user
can close, navigate, reopen, or use another device.

## Skill perspectives

### Controlled UX

- User goals define layout: choose/play/resume/install; inspect work; manage
  identity; create/recover private assets.
- Progressive disclosure keeps Envoy generation and offline management out of
  primary play flow.
- Destructive restart/remove/archive/delete actions need confirmation or undo.
- Empty, loading, disconnected, permission, quota, conflict, degraded, and
  success states need dedicated copy and controls.

### Game UI

- Shared shell handles pause, controls, mute, motion, save, and offline state;
  in-game HUD shows only mechanic-critical information.
- HUD must preserve safe areas for touch and never cover play-critical space.
- Input labels change with active device. Focus remains on play surface until
  paused; Escape opens pause rather than navigating unpredictably.
- Diegetic styling never replaces legible DOM controls/status.

### High-end visual

- One strong silhouette and one accent channel per surface.
- Depth comes from tonal layers, hairlines, material contrast, and restrained
  atmospheric texture—not generic neon gradients or glow everywhere.
- Generated covers must reveal a recognizable mechanic and leave intentional
  negative space for DOM metadata.
- Envoys need editorial, tailored shapes rather than toy proportions.

### Premium frontend

- Dense information stays structured through alignment, consistent metadata
  plates, stable geometry, and crisp interaction states.
- Every control has hover, focus, pressed, disabled, busy, success, and error
  behavior where applicable.
- Skeletons reserve final space; cards do not shift when sync/cover data arrives.
- Light mode is designed, not inverted: warm paper surfaces, graphite hairlines,
  restrained accent, dark readable cover scrims.

### Emil design engineering

- Motion explains state change: card selection, pause, save confirmation, job
  stage advance, and Envoy state transition.
- No permanent 60 fps idle loop. Envoy idle uses low-rate stepped animation;
  hidden/game-active states suspend it.
- Enter/exit durations stay short; spatial continuity matters more than flourish.
- Reduced motion replaces travel/particles/shake with opacity and instant state.

## Anti-slop review

Rejected:

- purple-blue gradient dashboard;
- fake CRT scanlines/chromatic aberration;
- pixel font for body or controls;
- `>_` face, robot, floating orb, terminal mascot;
- decorative console toggles;
- generic starfield cover unrelated to mechanic;
- oversized hero that hides Continue/conflict state;
- glass cards nested inside glass cards;
- status conveyed only by glow/color/pulse;
- fake percent or fake online/synced labels;
- excessive rounded pills and uniform card soup.

## Responsive adaptation

Desktop uses preview plus library rail. Tablet uses preview plus two-column
library. Mobile becomes:

1. module title and utility actions;
2. featured mechanic image;
3. primary Play/Resume and real status;
4. Continue strips;
5. one-column library;
6. offline manager.

Game route enters focused shell with safe-area padding and play-surface-owned
touch behavior. Mobile controls are configurable, thumb-reachable, and fade only
when inactivity cannot hide required information.

Envoy sprite moves away from game surface and can collapse to a small status
button. It never overlays game controls or critical HUD.

## Light-mode adaptation

- warm bone/paper background rather than pure white;
- graphite text/hairlines and muted raised surfaces;
- active accent retains user selection but loses dark-mode glow;
- generated covers get a controlled neutral edge/scrim for consistent contrast;
- status uses icon + label + semantic token, never color alone;
- Envoy sprites receive a subtle neutral keyline/shadow, not a luminous halo.

## Accessibility and reduced motion

- DOM headings, buttons, lists, progress text, status regions, and live regions;
- visible focus; logical order; no keyboard trap outside modal/pause scope;
- 44×44 minimum touch targets; safe-area support; zoom/reflow at 200%;
- text contrast verified in all themes; art never contains required copy;
- audio never conveys sole cue; mute persists; gamepad is additive;
- resolved motion preference reaches game and Envoy runtimes;
- Canvas/WebGL provide DOM instructions, score, state, and controls;
- status and job progress use text; animation is supplementary.

## Outcome

Design passes concept review with Instrument Deck and Work Card selected. Final
acceptance remains open until generated concept sheets, real browser layouts,
mobile/light screenshots, interaction QA, performance traces, and accessibility
checks exist.

Generated VECTOR concept evidence:

- `.logs/vector-envoys/concepts/vector-lobby-concepts-v1.png`
- SHA-256 `66c3256e6d85d8e24958f2b51eb414be9990efb82fab54894fd0ce59818ca01b`
- 1536×1024 PNG

Review note: generated board rendered readable labels despite prompt requesting
abstract type blocks. Treat it only as internal layout/material concept evidence,
never final shipped UI or cover art. Production UI remains DOM text.

Generated Envoy concept evidence:

- `.logs/vector-envoys/concepts/envoy-concepts-v1.png`
- SHA-256 `dcbe90802f1ecfc8832281c56f5136d55fa72cc71722404ecec7be5d2c6e56cd`
- 1536×1024 PNG

Visual critique: all eight read as distinct anthropomorphic, non-robotic
silhouettes at concept scale. Atlas, Morrow, Aster, Soma, Orin, Neri, Vesper,
and Bront remain candidates. Aster's face and Bront's tool density need
small-size tests; Soma's arm count needs an explicit atlas rig plan. No concept
is a shipped starter until hatch-pet state generation and deterministic QA pass.

Generated Envoy UX evidence:

- `.logs/vector-envoys/concepts/envoy-ux-concepts-v1.png`
- SHA-256 `e680d2119f69fe71bc2eff89451a876b29b14ece1274e52f22f4ebdc7f982349`
- 1536×1024 PNG

Review note: generated UX board correctly separates capability tabs, active-work
states, quick picker, library, state preview, generation history, mobile, and
light mode. Its rendered copy and repeated feline placeholder are internal
concept artifacts only. Production uses real DOM data and selected Envoy assets.
