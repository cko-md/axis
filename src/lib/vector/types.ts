import type { Json } from "@/lib/supabase/database.types";

export const VECTOR_GAME_SLUGS = [
  "second-sense",
  "brickrise",
  "time-to-fly",
  "paper-glider",
  "envoy-arena",
  "phantasy-axis",
  "biome-lab",
  "mini-town",
  "neon-rift",
] as const;

export type VectorGameSlug = (typeof VECTOR_GAME_SLUGS)[number];
export type VectorGameEngine = "native" | "phaser" | "three";
export type VectorGameStatus = "planned" | "available" | "maintenance";
export type VectorGameOrientation = "any" | "landscape" | "portrait";
export type VectorInputKind = "keyboard" | "pointer" | "touch" | "gamepad";

export type VectorArtwork =
  | {
      status: "planned";
      assetId: null;
      src: null;
      width: null;
      height: null;
      alt: string;
    }
  | {
      status: "ready";
      assetId: string;
      src: `/vector-assets/${string}`;
      width: number;
      height: number;
      alt: string;
    };

export type VectorControlDescriptor = {
  id: string;
  label: string;
  input: VectorInputKind;
  bindings: readonly string[];
  description: string;
};

export type VectorGameManifest = {
  id: VectorGameSlug;
  slug: VectorGameSlug;
  loaderKey: VectorGameSlug;
  title: string;
  subtitle: string;
  shortDescription: string;
  description: string;
  version: string;
  saveSchemaVersion: number;
  status: VectorGameStatus;
  availabilityReason: string;
  engine: VectorGameEngine;
  targetFrameRate: 30 | 60;
  orientation: VectorGameOrientation;
  minimumViewport: {
    width: number;
    height: number;
  };
  cover: VectorArtwork;
  preview: VectorArtwork;
  input: Record<VectorInputKind, boolean>;
  controls: readonly VectorControlDescriptor[];
  audio: {
    available: boolean;
    channels: readonly ("music" | "effects" | "ambient")[];
    description: string;
  };
  reducedMotionBehavior: string;
  accessibilityDescription: string;
  save: {
    local: boolean;
    cloud: boolean;
    slots: "single" | "multiple";
    deterministicSeed: boolean;
  };
  score: {
    kind: "none" | "personal-unverified" | "server-verified";
    achievements: boolean;
    leaderboard: boolean;
    label: string;
  };
  offline: {
    available: boolean;
    assetIds: readonly string[];
    estimatedBytes: number | null;
    compatibility: string;
  };
  visualMotif: "dial" | "ascent" | "orbit" | "flight" | "arena" | "rune" | "biome" | "blocks" | "rift";
};

export type VectorSyncState =
  | "local-only"
  | "pending"
  | "syncing"
  | "synced"
  | "conflict"
  | "error";

export type VectorSaveSummary = {
  gameId: VectorGameSlug;
  slotId: string;
  gameVersion: string;
  saveSchemaVersion: number;
  localRevision: number;
  serverRevision: number | null;
  updatedAt: string;
  syncState: VectorSyncState;
  conflictCount: number;
  canResume: boolean;
  checkpointLabel?: string;
};

export type VectorInstallState =
  | "not-installed"
  | "installing"
  | "installed"
  | "update-available"
  | "removing"
  | "error";

export type VectorInstallSummary = {
  gameId: VectorGameSlug;
  state: VectorInstallState;
  estimatedBytes: number | null;
  installedBytes: number;
  buildId?: string;
  errorCode?: string;
};

export type VectorGamePersistenceSummary = {
  gameId: VectorGameSlug;
  saves: readonly VectorSaveSummary[];
  preferredSlotId?: string;
  conflictCount: number;
  preferredConflictSlotId?: string;
  pendingEventCount: number;
  syncState: VectorSyncState;
  install: VectorInstallSummary;
};

export type VectorLocalDataState =
  | { status: "loading"; message?: string }
  | { status: "ready"; message?: string }
  | { status: "unavailable" | "quota" | "error"; message: string };

export type VectorOfflineStorageSummary = {
  loading: boolean;
  supported: boolean;
  statusAvailable: boolean;
  installs: readonly VectorInstallSummary[];
  installableGameIds: readonly VectorGameSlug[];
  busy: {
    gameId: VectorGameSlug;
    operation: "install" | "remove";
  } | null;
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
  error: string | null;
};

export type VectorLibraryActions = {
  onPlay: (gameId: VectorGameSlug) => void;
  onResume: (gameId: VectorGameSlug, slotId: string) => void;
  onRestart: (gameId: VectorGameSlug, slotId: string) => void;
  onSync: (gameId: VectorGameSlug) => void;
  onInstall: (gameId: VectorGameSlug) => void;
  onRemoveInstall: (gameId: VectorGameSlug) => void;
  onOpenConflicts: (gameId: VectorGameSlug, slotId: string) => void;
  onRequestPersistentStorage: () => void;
  onClearOwnerData: () => Promise<void>;
};

export type VectorMotionPreference = "system" | "standard" | "reduced";
export type VectorResolvedMotion = "standard" | "reduced";

export type VectorRuntimeSettings = {
  motionPreference: VectorMotionPreference;
  resolvedMotion: VectorResolvedMotion;
  muted: boolean;
  volume: number;
  lowPower: boolean;
};

export const DEFAULT_VECTOR_RUNTIME_SETTINGS: VectorRuntimeSettings = {
  motionPreference: "system",
  resolvedMotion: "standard",
  muted: false,
  volume: 0.7,
  lowPower: false,
};

export type VectorRuntimeState =
  | "idle"
  | "initializing"
  | "ready"
  | "running"
  | "paused"
  | "suspended"
  | "error"
  | "disposed";

export type VectorPauseReason = "user" | "visibility" | "blur" | "system";
export type VectorSaveReason =
  | "checkpoint"
  | "autosave"
  | "pause"
  | "visibility"
  | "pagehide"
  | "route-exit"
  | "migration"
  | "restart";

export type VectorSerializedSave = {
  schemaVersion: number;
  data: unknown;
  checksum?: string;
  seed?: string;
};

export type VectorSaveMigrator = {
  from: number;
  to: number;
  migrate: (state: Json) => Json;
};

export type VectorRuntimeEvent = {
  type: string;
  occurredAt: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
};

export type VectorRuntimeFrame = {
  nowMs: number;
  steps: number;
  stepMs: number;
  elapsedMs: number;
  droppedMs: number;
  alpha: number;
};

export type VectorRuntimeScheduler = {
  subscribe: (listener: (frame: VectorRuntimeFrame) => void) => () => void;
  start: () => void;
  stop: () => void;
  dispose: () => void;
  isRunning: () => boolean;
};

export type VectorGameScoreInput = {
  /** Free-form mode key (e.g. "practice", "daily"); matches the shared score contract. */
  mode: string;
  /** Present only for repeatable named challenges, e.g. a daily UTC day key. */
  challengeId: string | null;
  /** Non-negative integer. Higher is always better under the shared merge (Math.max). */
  value: number;
};

export type VectorGameCreateContext = {
  mount: HTMLElement;
  manifest: VectorGameManifest;
  settings: VectorRuntimeSettings;
  scheduler: VectorRuntimeScheduler;
  emit: (event: VectorRuntimeEvent) => void;
  /**
   * Record a durable score event through the platform's real sync pipeline
   * (local outbox -> apply_vector_event -> cloud profile.scores), the same
   * path saves use. Optional: a game that has no authoritative score (e.g.
   * `score.kind === "none"`) never needs to call it. Absent instead of a
   * no-op function when the host has nothing to wire it to, so a game can
   * tell the difference between "not recorded yet" and "cannot be recorded
   * here."
   */
  recordScore?: (input: VectorGameScoreInput) => void | Promise<void>;
  /**
   * Read back the current best value for a mode/challenge under the same
   * shared merge `recordScore` writes through (Math.max — see
   * mergeVectorBestScore), so a game can show "personal best" without
   * tracking a second, potentially-drifting copy of that number itself.
   * Resolves null if there is no recorded score yet, not an error.
   */
  getBestScore?: (input: { mode: string; challengeId: string | null }) => Promise<number | null>;
};

export type VectorGameInstance = {
  initialize: () => void | Promise<void>;
  hydrate: (save: VectorSerializedSave | null) => void | Promise<void>;
  start: () => void | Promise<void>;
  pause: (reason: VectorPauseReason) => void | Promise<void>;
  resume: () => void | Promise<void>;
  serialize: () => VectorSerializedSave | Promise<VectorSerializedSave>;
  reset: () => void | Promise<void>;
  updateSettings?: (settings: VectorRuntimeSettings) => void | Promise<void>;
  handleContextLoss?: () => void | Promise<void>;
  handleContextRestore?: () => void | Promise<void>;
  dispose: () => void | Promise<void>;
};

export type VectorGameModule = {
  saveMigrators?: readonly VectorSaveMigrator[];
  createGame: (context: VectorGameCreateContext) => VectorGameInstance | Promise<VectorGameInstance>;
};

export type VectorGameLoaderDescriptor = {
  engine: VectorGameEngine;
  load: () => Promise<VectorGameModule>;
};
