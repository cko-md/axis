import type { EntityRef } from "@/lib/entities/types";

export const WORKSPACE_STATE_VERSION = 1 as const;
export const PRIMARY_PANE_ID = "primary" as const;
export const MAX_SECONDARY_PANES = 2;
export const MAX_PANE_HISTORY_ENTRIES = 12;
export const MAX_ENCODED_WORKSPACE_STATE_LENGTH = 4_096;
export const MAX_WORKSPACE_PANE_ID_LENGTH = 64;

/** Pane widths are stored as integer basis points (1/100 of one percent). */
export const MIN_PANE_WIDTH_BPS = 1_800;
export const DEFAULT_PANE_WIDTH_BPS = 3_600;
export const MAX_PANE_WIDTH_BPS = 6_000;

export type WorkspacePaneId = typeof PRIMARY_PANE_ID | string;

export type WorkspacePaneHistory = Readonly<{
  current: EntityRef | null;
  back: readonly EntityRef[];
  forward: readonly EntityRef[];
}>;

export type WorkspaceSecondaryPane = WorkspacePaneHistory &
  Readonly<{
    id: string;
    widthBps: number;
    current: EntityRef;
  }>;

export type WorkspaceState = Readonly<{
  version: typeof WORKSPACE_STATE_VERSION;
  activePaneId: WorkspacePaneId;
  primary: WorkspacePaneHistory;
  panes: readonly WorkspaceSecondaryPane[];
}>;

export const WORKSPACE_CODEC_ERROR_CODES = [
  "EMPTY_STATE",
  "STATE_TOO_LARGE",
  "INVALID_ENCODING",
  "INVALID_JSON",
  "INVALID_SHAPE",
  "UNSUPPORTED_VERSION",
  "TOO_MANY_PANES",
  "HISTORY_LIMIT_EXCEEDED",
  "DUPLICATE_PANE_ID",
  "DUPLICATE_ENTITY_REF",
  "INVALID_ACTIVE_PANE",
  "INVALID_PANE_ID",
  "INVALID_WIDTH",
  "UNKNOWN_ENTITY_KIND",
  "INVALID_ENTITY_REF",
] as const;

export type WorkspaceCodecErrorCode =
  (typeof WORKSPACE_CODEC_ERROR_CODES)[number];

/**
 * Codec errors deliberately contain only a stable code. The encoded URL state,
 * entity identifiers, and decoded JSON must never be attached to an error.
 */
export type WorkspaceCodecError = Readonly<{
  code: WorkspaceCodecErrorCode;
}>;

export type WorkspaceCodecResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: WorkspaceCodecError }>;

export type WorkspaceAction =
  | Readonly<{ type: "open"; ref: EntityRef }>
  | Readonly<{ type: "close"; paneId: string }>
  | Readonly<{ type: "navigate"; paneId: WorkspacePaneId; ref: EntityRef }>
  | Readonly<{ type: "back"; paneId: WorkspacePaneId }>
  | Readonly<{ type: "forward"; paneId: WorkspacePaneId }>
  | Readonly<{ type: "focus"; paneId: WorkspacePaneId }>
  | Readonly<{ type: "resize"; paneId: string; widthBps: number }>;
