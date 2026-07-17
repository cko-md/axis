import type { Json } from "@/lib/supabase/database.types";
import type {
  VectorCloudConflict,
  VectorConflictResolution,
  VectorSyncEvent,
} from "@/lib/vector/contracts";
import type { VectorGameSlug, VectorSyncState } from "@/lib/vector/types";

export type VectorOwnerKey = `anonymous:${string}` | `user:${string}`;

export type VectorSettingClock = {
  at: string;
  deviceId: string;
};

export type VectorLocalProfile = {
  ownerKey: VectorOwnerKey;
  deviceId: string;
  settings: Record<string, Json>;
  settingClocks: Record<string, VectorSettingClock>;
  unlocks: string[];
  scores: Record<string, number>;
  counters: Record<string, number>;
  serverRevision: number;
  syncState: VectorSyncState;
  updatedAt: string;
};

export type VectorLocalSave = {
  id: string;
  ownerKey: VectorOwnerKey;
  gameId: VectorGameSlug;
  slotId: string;
  gameVersion: string;
  saveSchemaVersion: number;
  localRevision: number;
  serverRevision: number;
  pendingIdempotencyKey: string;
  deviceId: string;
  checksum: string;
  integrityChecksum?: string;
  seed: string | null;
  state: Json;
  checkpointLabel?: string;
  updatedAt: string;
  syncState: VectorSyncState;
  lastErrorCode: string | null;
};

export type VectorOutboxStatus = "pending" | "sending" | "error" | "frozen";

export type VectorLocalOutboxEvent = {
  id: string;
  ownerKey: VectorOwnerKey;
  gameId: VectorGameSlug;
  event: VectorSyncEvent;
  payloadHash: string;
  status: VectorOutboxStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VectorLocalConflict = Omit<VectorCloudConflict, "local" | "server"> & {
  ownerKey: VectorOwnerKey;
  authority: "local" | "cloud";
  resolution?: VectorConflictResolution["resolution"] | null;
  expectedAncestorLocalRevision?: number | null;
  expectedAncestorChecksum?: string | null;
  currentLocalRevision?: number | null;
  currentIntegrityChecksum?: string | null;
  currentSyncState?: VectorSyncState | null;
  currentLastErrorCode?: string | null;
  local: VectorCloudConflict["local"] & {
    integrityChecksum?: string;
    checkpointLabel?: string | null;
  };
  server: VectorCloudConflict["server"] & { integrityChecksum?: string };
};

export type VectorLocalInstall = {
  id: string;
  deviceId: string;
  gameId: VectorGameSlug;
  gameVersion: string;
  buildId: string;
  cacheName: string;
  installedBytes: number;
  validationState: "staging" | "installed" | "error";
  updatedAt: string;
};

export type VectorLocalMeta = {
  key: string;
  value: Json;
  updatedAt: string;
};
