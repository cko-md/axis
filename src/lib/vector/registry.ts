import {
  VECTOR_GAME_SLUGS,
  type VectorArtwork,
  type VectorControlDescriptor,
  type VectorGameEngine,
  type VectorGameManifest,
  type VectorGameSlug,
} from "@/lib/vector/types";

const plannedArtwork = (alt: string): VectorArtwork => ({
  status: "planned",
  assetId: null,
  src: null,
  width: null,
  height: null,
  alt,
});

const control = (
  id: string,
  label: string,
  input: VectorControlDescriptor["input"],
  bindings: readonly string[],
  description: string,
): VectorControlDescriptor => ({ id, label, input, bindings, description });

const planned = (
  manifest: Omit<
    VectorGameManifest,
    | "version"
    | "saveSchemaVersion"
    | "status"
    | "cover"
    | "preview"
    | "targetFrameRate"
    | "offline"
    | "loaderKey"
    | "audio"
  >,
): VectorGameManifest => ({
  ...manifest,
  loaderKey: manifest.id,
  version: "0.0.0",
  saveSchemaVersion: 1,
  status: "planned",
  targetFrameRate: 60,
  cover: plannedArtwork(`${manifest.title} cover artwork is pending a playable mechanic review.`),
  preview: plannedArtwork(`${manifest.title} preview is unavailable until the game is playable.`),
  audio: {
    available: false,
    channels: [],
    description: "Audio remains disabled until the playable build provides verified mute and volume behavior.",
  },
  offline: {
    available: false,
    assetIds: [],
    estimatedBytes: null,
    compatibility: "Offline installation unlocks only after a complete playable build is verified.",
  },
});

// Measured from a real production build's offline manifest (five assets: the
// webpack loader chunk, the standalone offline HTML/JS bootstrap, and both
// artwork files). Re-measure via `npm run build` + inspecting
// public/vector-assets/manifests/second-sense-<buildId>.json if these assets
// change materially; the shared build-map validator does not require this
// constant to match the real manifest exactly, but the UI's install-size
// estimate should stay honest.
const SECOND_SENSE_OFFLINE_ESTIMATED_BYTES = 285_952;

export const VECTOR_GAME_REGISTRY = [
  {
    id: "second-sense",
    slug: "second-sense",
    loaderKey: "second-sense",
    title: "Second Sense",
    subtitle: "Measure time without seeing it.",
    shortDescription: "Reproduce hidden intervals from memory.",
    description:
      "Five timing trials show a hidden interval, then hide the clock during reproduction. Absolute and proportional error are scored deterministically across Easy and Hard difficulties, solo practice, and a deterministic daily challenge with a UTC-day seed.",
    version: "1.0.0",
    saveSchemaVersion: 1,
    status: "available",
    availabilityReason: "Shipped in Wave 15.3 as the first complete VECTOR title.",
    engine: "native",
    targetFrameRate: 60,
    orientation: "any",
    minimumViewport: { width: 320, height: 480 },
    cover: {
      status: "ready",
      assetId: "second-sense-cover",
      src: "/vector-assets/second-sense/cover.svg",
      width: 960,
      height: 540,
      alt: "A radial timing dial artwork for Second Sense.",
    },
    preview: {
      status: "ready",
      assetId: "second-sense-preview",
      src: "/vector-assets/second-sense/preview.svg",
      width: 480,
      height: 480,
      alt: "A compact radial dial preview for Second Sense.",
    },
    input: { keyboard: true, pointer: true, touch: true, gamepad: false },
    controls: [
      control("hold-key", "Hold interval", "keyboard", ["Space"], "Hold Space, then release when the remembered interval has elapsed."),
      control("hold-pointer", "Hold interval", "pointer", ["Primary button"], "Press and hold the timing surface, then release."),
      control("hold-touch", "Hold interval", "touch", ["Press and hold"], "Touch and hold the timing surface, then release."),
    ],
    audio: {
      available: false,
      channels: [],
      description: "Second Sense ships without audio in its first release; visual and DOM text carry every result.",
    },
    reducedMotionBehavior: "Travel effects are replaced by opacity and immediate result changes.",
    accessibilityDescription: "All timing prompts, scores, state, and controls remain available as DOM text and buttons.",
    save: { local: true, cloud: true, slots: "single", deterministicSeed: true },
    score: { kind: "personal-unverified", achievements: false, leaderboard: false, label: "Lowest timing error" },
    offline: {
      available: true,
      assetIds: [
        "second-sense-cover",
        "second-sense-preview",
        "second-sense-offline-entry",
        "second-sense-offline-bundle",
      ],
      estimatedBytes: SECOND_SENSE_OFFLINE_ESTIMATED_BYTES,
      compatibility: "Installs the play surface, artwork, and a standalone offline bootstrap for a full cold launch without a network connection.",
    },
    visualMotif: "dial",
  } satisfies VectorGameManifest,
  planned({
    id: "brickrise",
    slug: "brickrise",
    title: "Brickrise",
    subtitle: "Every fall costs time, never progress.",
    shortDescription: "A compact vertical platforming ascent.",
    description:
      "A responsive Phaser platformer built around air control, hazards, checkpoints, and a readable summit. The initial complete run targets three to five minutes.",
    availabilityReason: "Mechanics and runtime are complete; release is planned once original artwork lands.",
    engine: "phaser",
    orientation: "landscape",
    minimumViewport: { width: 640, height: 480 },
    // pointer: the on-screen controls are driven by Pointer Events, so they
    // are genuinely mouse- and pen-operable, not touch-only.
    input: { keyboard: true, pointer: true, touch: true, gamepad: false },
    controls: [
      control("move", "Move", "keyboard", ["Arrow Left", "Arrow Right", "A", "D"], "Move along platforms and control direction in the air."),
      control("jump", "Jump", "keyboard", ["Space", "Arrow Up", "W"], "Jump from ledges and platforms."),
      control("touch-move", "Move and jump", "touch", ["Left control", "Right control", "Jump control"], "Use thumb-reachable movement and jump controls."),
    ],
    // Only the camera-travel branch is real (game.ts's cameraY lerp-vs-snap
    // split). There is no shake and no particle system anywhere in the shell
    // — claiming reduced alternatives for effects that do not exist is the
    // same class of empty promise the achievements flag below was fixed for.
    reducedMotionBehavior: "Camera travel uses a nausea-safe reduced alternative that snaps rather than eases.",
    accessibilityDescription: "DOM instructions, checkpoint state, pause controls, and run results supplement the play surface.",
    // deterministicSeed stays false and that is correct, not an oversight:
    // generation is fully seeded, but the seed itself is a fresh random UUID
    // per run. Second Sense sets this true because its daily challenge derives
    // the seed from the UTC day; Brickrise has no equivalent shared-tower mode,
    // so no two players are promised the same climb.
    save: { local: true, cloud: true, slots: "single", deterministicSeed: false },
    // achievements: false — no Brickrise achievement is defined anywhere, and
    // the runtime event sanitiser drops string achievementId values outright.
    // Claiming the capability while shipping none of it is the kind of empty
    // promise the registry validation exists to prevent.
    score: { kind: "personal-unverified", achievements: false, leaderboard: false, label: "Fastest summit" },
    visualMotif: "ascent",
  }),
  planned({
    id: "time-to-fly",
    slug: "time-to-fly",
    title: "Time to Fly",
    subtitle: "Arrange gravity, then commit to launch.",
    shortDescription: "A deterministic orbital launch puzzle.",
    description:
      "Five seeded levels use fixed circular orbits and materially necessary planets. Starting positions remain stable across unlimited retries, with no trajectory preview.",
    availabilityReason: "Planned for Wave 15.9 after Brickrise passes its complete-game gate.",
    engine: "phaser",
    orientation: "landscape",
    minimumViewport: { width: 640, height: 480 },
    input: { keyboard: true, pointer: true, touch: true, gamepad: false },
    controls: [
      control("launch", "Launch", "keyboard", ["Space"], "Launch the craft after arranging the system."),
      control("drag-planets", "Position planets", "pointer", ["Drag"], "Move planets around their fixed orbit before launch."),
      control("touch-planets", "Position planets", "touch", ["Drag"], "Move planets around their fixed orbit before launch."),
    ],
    reducedMotionBehavior: "Launch and arrival sequences shorten while preserving orbital state and collision clarity.",
    accessibilityDescription: "Planet properties, level state, controls, launch result, and retry actions are represented in DOM text.",
    save: { local: true, cloud: true, slots: "single", deterministicSeed: true },
    score: { kind: "personal-unverified", achievements: true, leaderboard: false, label: "Levels solved" },
    visualMotif: "orbit",
  }),
  planned({
    id: "paper-glider",
    slug: "paper-glider",
    title: "Paper Glider",
    subtitle: "Thread warm rooms at gathering speed.",
    shortDescription: "Continuous procedural low-poly flight.",
    description:
      "Guide a paper glider through procedurally assembled rooms, collect rings, and avoid furniture and walls as the speed curve rises.",
    availabilityReason: "Planned for Wave 15.10 after Time to Fly is complete.",
    engine: "three",
    orientation: "landscape",
    minimumViewport: { width: 640, height: 480 },
    // keyboard: the shell's input state machine steers with Arrows/WASD
    // through the same reducer as pointer and touch, so the claim is real —
    // and steering is reachable without a pointer at all (WCAG 2.1.1).
    input: { keyboard: true, pointer: true, touch: true, gamepad: false },
    controls: [
      control("steer-pointer", "Steer", "pointer", ["Pointer movement"], "Guide the glider across the flight surface."),
      control("steer-touch", "Steer", "touch", ["Touch drag"], "Guide the glider with a continuous touch gesture."),
      control("steer-keys", "Steer", "keyboard", ["Arrow keys", "WASD"], "Steer the glider without a pointer."),
    ],
    // Only what the shell actually does: camera easing snaps and the cosmetic
    // glider bank/pitch is removed. No curtains, dust, or loose pages exist —
    // claiming reduced alternatives for effects that do not exist is the same
    // empty-promise class the Brickrise manifest was fixed for.
    reducedMotionBehavior: "Camera easing snaps and cosmetic glider banking is removed; the simulation is unchanged.",
    accessibilityDescription: "Score, speed, collision result, pause, and restart remain available outside WebGL.",
    save: { local: true, cloud: true, slots: "single", deterministicSeed: false },
    // achievements: false — no Paper Glider achievement is defined anywhere,
    // and the runtime event sanitiser drops string achievementId values
    // outright. Same fix as Brickrise: claiming the capability while shipping
    // none of it is the empty promise registry validation exists to prevent.
    score: { kind: "personal-unverified", achievements: false, leaderboard: false, label: "Longest flight" },
    visualMotif: "flight",
  }),
  planned({
    id: "envoy-arena",
    slug: "envoy-arena",
    title: "Envoy Arena",
    subtitle: "Gather signal. Grow. Hold the lead.",
    shortDescription: "Eight Envoys compete across a changing platform arena.",
    description:
      "Choose from the shared Envoy registry, collect Axis tokens, grow to three times scale, and dislodge rivals across moving terrain and a low-gravity Moon map.",
    availabilityReason: "Planned for Wave 15.11 after shared Envoy identity packages exist.",
    engine: "phaser",
    orientation: "landscape",
    minimumViewport: { width: 720, height: 480 },
    input: { keyboard: true, pointer: false, touch: true, gamepad: true },
    controls: [
      control("arena-move", "Move", "keyboard", ["Arrow keys", "WASD"], "Move and control the selected Envoy."),
      control("arena-jump", "Jump", "keyboard", ["Space"], "Jump, use platforms, and stomp competitors."),
      control("arena-touch", "Move and jump", "touch", ["Movement pad", "Jump control"], "Use configurable thumb-reachable arena controls."),
      control("arena-gamepad", "Gamepad", "gamepad", ["Left stick", "Primary face button"], "Move and jump with an optional gamepad."),
    ],
    reducedMotionBehavior: "Particles, shake, growth travel, and map transitions use restrained or instant alternatives.",
    accessibilityDescription: "Leaderboard, scale, score, map state, mute, and pause controls remain legible DOM content.",
    save: { local: true, cloud: true, slots: "single", deterministicSeed: true },
    score: { kind: "personal-unverified", achievements: true, leaderboard: true, label: "Arena score" },
    visualMotif: "arena",
  }),
  planned({
    id: "phantasy-axis",
    slug: "phantasy-axis",
    title: "Phantasy Axis",
    subtitle: "Build a run through an unfamiliar world.",
    shortDescription: "A compact original procedural action RPG.",
    description:
      "Explore a bounded procedural world with sword, spear, and wand builds, reactive creatures, XP choices, upgrades, and an inspectable character sheet.",
    availabilityReason: "Planned for Wave 15.12 after Envoy Arena is complete.",
    engine: "phaser",
    orientation: "landscape",
    minimumViewport: { width: 640, height: 480 },
    input: { keyboard: true, pointer: false, touch: true, gamepad: false },
    controls: [
      control("rpg-move", "Move", "keyboard", ["Arrow keys", "WASD"], "Move through the procedural world."),
      control("rpg-action", "Attack or interact", "keyboard", ["Space", "Enter"], "Use the equipped weapon or interact with the world."),
      control("rpg-touch", "Move and act", "touch", ["Movement pad", "Action control"], "Use configurable movement and action controls."),
    ],
    reducedMotionBehavior: "Hit shake, reward bursts, and transitions become static emphasis and opacity changes.",
    accessibilityDescription: "Health, stamina, XP, current build, choices, and run results are mirrored in DOM UI.",
    save: { local: true, cloud: true, slots: "multiple", deterministicSeed: true },
    score: { kind: "personal-unverified", achievements: true, leaderboard: true, label: "Run level and XP" },
    visualMotif: "rune",
  }),
  planned({
    id: "biome-lab",
    slug: "biome-lab",
    title: "Biome Lab",
    subtitle: "Change one condition and watch the system answer.",
    shortDescription: "A deterministic living terrarium.",
    description:
      "Terrain, water, plants, and bounded animal populations react visibly to rainfall, temperature, terrain height, water level, and species balance.",
    availabilityReason: "Planned for Wave 15.13 after Phantasy Axis is complete.",
    engine: "three",
    orientation: "landscape",
    minimumViewport: { width: 640, height: 520 },
    input: { keyboard: true, pointer: true, touch: true, gamepad: false },
    controls: [
      control("biome-controls", "Adjust environment", "pointer", ["Sliders", "Buttons"], "Change environmental inputs and inspect the simulation response."),
      control("biome-touch", "Adjust environment", "touch", ["Sliders", "Buttons"], "Change environmental inputs using touch controls."),
      control("biome-keyboard", "Operate controls", "keyboard", ["Tab", "Arrow keys", "Enter"], "Navigate and adjust every simulation control from the keyboard."),
    ],
    reducedMotionBehavior: "Ambient motion reduces while state changes remain immediate and visually legible.",
    accessibilityDescription: "Every control, population trend, preset, seed, and simulation state has a DOM representation.",
    save: { local: true, cloud: true, slots: "multiple", deterministicSeed: true },
    score: { kind: "none", achievements: true, leaderboard: false, label: "No ranked score" },
    visualMotif: "biome",
  }),
  planned({
    id: "mini-town",
    slug: "mini-town",
    title: "MiniTown",
    subtitle: "Draw a block and let a place emerge.",
    shortDescription: "A bounded miniature town simulation.",
    description:
      "Place residential, shop, and workspace blocks, watch construction and occupancy, and follow residents across perimeter-road neighborhoods and a day-night cycle.",
    availabilityReason: "Planned for Wave 15.14 after Biome Lab is complete.",
    engine: "three",
    orientation: "landscape",
    minimumViewport: { width: 720, height: 520 },
    input: { keyboard: true, pointer: true, touch: true, gamepad: false },
    controls: [
      control("town-place", "Place shared block", "pointer", ["Click and drag"], "Draw a shared block containing one to three buildings."),
      control("town-touch", "Place shared block", "touch", ["Touch drag"], "Draw a shared block using touch."),
      control("town-keyboard", "Navigate tools", "keyboard", ["Tab", "Arrow keys", "Enter"], "Select zones, inspect entities, and operate management controls."),
    ],
    reducedMotionBehavior: "Camera travel, construction flourishes, and traffic animation reduce without hiding state.",
    accessibilityDescription: "Zone tools, block contents, residents, schedules, occupancy, and time of day remain inspectable as DOM text.",
    save: { local: true, cloud: true, slots: "multiple", deterministicSeed: true },
    score: { kind: "none", achievements: true, leaderboard: false, label: "No ranked score" },
    visualMotif: "blocks",
  }),
  planned({
    id: "neon-rift",
    slug: "neon-rift",
    title: "Neon Rift",
    subtitle: "Read the lane. Break the wave.",
    shortDescription: "A compact original voxel FPS mission.",
    description:
      "Enter one polished modular arena, switch among three materially distinct weapons, survive enemy pressure, collect pickups, and complete a bounded mission loop.",
    availabilityReason: "Planned last for Wave 15.15 after every preceding game is complete.",
    engine: "three",
    orientation: "landscape",
    minimumViewport: { width: 800, height: 540 },
    input: { keyboard: true, pointer: true, touch: true, gamepad: true },
    controls: [
      control("rift-move", "Move", "keyboard", ["WASD"], "Move through the arena."),
      control("rift-look", "Look and fire", "pointer", ["Pointer movement", "Primary button"], "Aim and use the equipped weapon."),
      control("rift-touch", "Move, look, and fire", "touch", ["Movement pad", "Look area", "Fire control"], "Use device-appropriate configurable touch controls."),
      control("rift-gamepad", "Gamepad", "gamepad", ["Sticks", "Triggers", "Face buttons"], "Use optional gamepad movement, look, fire, and weapon switching."),
    ],
    reducedMotionBehavior: "Weapon recoil, camera shake, hit flash, and transition travel use reduced alternatives.",
    accessibilityDescription: "Health, weapon, ammo, mission state, score, pickups, pause, and restart remain available as DOM UI.",
    save: { local: true, cloud: true, slots: "single", deterministicSeed: true },
    score: { kind: "personal-unverified", achievements: true, leaderboard: false, label: "Mission score" },
    visualMotif: "rift",
  }),
] satisfies readonly VectorGameManifest[];

export type VectorRegistryIssue = {
  code:
    | "DUPLICATE_ID"
    | "DUPLICATE_SLUG"
    | "INVALID_VERSION"
    | "INVALID_SAVE_SCHEMA"
    | "INVALID_VIEWPORT"
    | "DUPLICATE_CONTROL"
    | "IMPOSSIBLE_CONTROL"
    | "INVALID_ARTWORK"
    | "INVALID_OFFLINE_MANIFEST"
    | "LOADER_KEY_MISMATCH"
    | "AVAILABLE_WITHOUT_LOADER"
    | "ENGINE_LOADER_MISMATCH"
    | "AVAILABLE_WITHOUT_ARTWORK"
    | "AVAILABLE_WITH_PLACEHOLDER_VERSION";
  gameId: string;
  message: string;
};

type LoaderEngines = Partial<Record<VectorGameSlug, VectorGameEngine>>;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function artworkIssues(game: VectorGameManifest, artwork: VectorArtwork, kind: "cover" | "preview") {
  const issues: VectorRegistryIssue[] = [];
  if (artwork.status === "ready") {
    if (!artwork.assetId.trim() || !artwork.src.startsWith("/vector-assets/") || artwork.width <= 0 || artwork.height <= 0) {
      issues.push({
        code: "INVALID_ARTWORK",
        gameId: game.id,
        message: `${game.id} has invalid ${kind} artwork metadata.`,
      });
    }
  } else if (artwork.assetId !== null || artwork.src !== null || artwork.width !== null || artwork.height !== null) {
    issues.push({
      code: "INVALID_ARTWORK",
      gameId: game.id,
      message: `${game.id} planned ${kind} artwork must not claim an asset or dimensions.`,
    });
  }
  return issues;
}

export function getVectorRegistryIssues(
  registry: readonly VectorGameManifest[] = VECTOR_GAME_REGISTRY,
  loaderEngines: LoaderEngines = {},
): VectorRegistryIssue[] {
  const issues: VectorRegistryIssue[] = [];
  const ids = new Set<string>();
  const slugs = new Set<string>();

  for (const game of registry) {
    if (ids.has(game.id)) {
      issues.push({ code: "DUPLICATE_ID", gameId: game.id, message: `Duplicate VECTOR game id: ${game.id}.` });
    }
    ids.add(game.id);

    if (slugs.has(game.slug)) {
      issues.push({ code: "DUPLICATE_SLUG", gameId: game.id, message: `Duplicate VECTOR game slug: ${game.slug}.` });
    }
    slugs.add(game.slug);

    if (!SEMVER.test(game.version)) {
      issues.push({ code: "INVALID_VERSION", gameId: game.id, message: `${game.id} has an invalid semantic version.` });
    }
    if (!Number.isSafeInteger(game.saveSchemaVersion) || game.saveSchemaVersion < 1) {
      issues.push({ code: "INVALID_SAVE_SCHEMA", gameId: game.id, message: `${game.id} has an invalid save schema version.` });
    }
    if (game.minimumViewport.width < 280 || game.minimumViewport.height < 320) {
      issues.push({ code: "INVALID_VIEWPORT", gameId: game.id, message: `${game.id} has an impossible minimum viewport.` });
    }

    const controlIds = new Set<string>();
    for (const descriptor of game.controls) {
      if (controlIds.has(descriptor.id)) {
        issues.push({ code: "DUPLICATE_CONTROL", gameId: game.id, message: `${game.id} repeats control ${descriptor.id}.` });
      }
      controlIds.add(descriptor.id);
      if (!game.input[descriptor.input] || descriptor.bindings.length === 0) {
        issues.push({
          code: "IMPOSSIBLE_CONTROL",
          gameId: game.id,
          message: `${game.id} declares an unavailable or unbound ${descriptor.input} control.`,
        });
      }
    }

    issues.push(...artworkIssues(game, game.cover, "cover"));
    issues.push(...artworkIssues(game, game.preview, "preview"));

    if (
      game.offline.available
      && (game.offline.assetIds.length === 0 || game.offline.estimatedBytes === null || game.offline.estimatedBytes <= 0)
    ) {
      issues.push({
        code: "INVALID_OFFLINE_MANIFEST",
        gameId: game.id,
        message: `${game.id} enables offline install without a complete asset manifest and byte estimate.`,
      });
    }

    if (game.loaderKey !== game.id) {
      issues.push({
        code: "LOADER_KEY_MISMATCH",
        gameId: game.id,
        message: `${game.id} loader key must match the registry game identity.`,
      });
    }
    const loaderEngine = loaderEngines[game.loaderKey];
    if (game.status === "available") {
      if (!loaderEngine) {
        issues.push({
          code: "AVAILABLE_WITHOUT_LOADER",
          gameId: game.id,
          message: `${game.id} is available without a loader.`,
        });
      } else if (loaderEngine !== game.engine) {
        issues.push({
          code: "ENGINE_LOADER_MISMATCH",
          gameId: game.id,
          message: `${game.id} manifest engine does not match its loader.`,
        });
      }
      if (game.cover.status !== "ready" || game.preview.status !== "ready") {
        issues.push({
          code: "AVAILABLE_WITHOUT_ARTWORK",
          gameId: game.id,
          message: `${game.id} is available without reviewed cover and preview assets.`,
        });
      }
      if (game.version === "0.0.0") {
        issues.push({
          code: "AVAILABLE_WITH_PLACEHOLDER_VERSION",
          gameId: game.id,
          message: `${game.id} is available with the planning-only version.`,
        });
      }
    }
  }

  return issues;
}

export function assertValidVectorRegistry(
  registry: readonly VectorGameManifest[] = VECTOR_GAME_REGISTRY,
  loaderEngines: LoaderEngines = {},
) {
  const issues = getVectorRegistryIssues(registry, loaderEngines);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  }
}

const VECTOR_SLUG_SET = new Set<string>(VECTOR_GAME_SLUGS);

export function isVectorGameSlug(value: string): value is VectorGameSlug {
  return VECTOR_SLUG_SET.has(value);
}

export function getVectorGame(slug: string): VectorGameManifest | undefined {
  if (!isVectorGameSlug(slug)) return undefined;
  return VECTOR_GAME_REGISTRY.find((game) => game.slug === slug);
}

export function requireVectorGame(slug: string): VectorGameManifest {
  const game = getVectorGame(slug);
  if (!game) throw new Error(`Unknown VECTOR game: ${slug}`);
  return game;
}
