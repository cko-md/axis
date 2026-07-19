"use client";

/**
 * Archive Bay (Phase 16.1) — renderer-side types and access to the desktop
 * bridge exposed by electron/axis-preload.cjs.
 *
 * Desktop-only by construction: `window.axisDesktop.archiveBay` exists only
 * inside the Electron app. The web build ships ONLY these thin type-safe
 * accessors (no emulator, no ROM handling, nothing content-related) — the
 * entire feature is inert on the web, and no filesystem path ever crosses
 * this boundary in either direction (titles are addressed by an opaque
 * contentId; file selection happens in native OS dialogs owned by the
 * Electron main process).
 */

export type LegacyRuntimeKind = "external-emulator" | "managed-emulator" | "native-recomp";

/** Renderer-safe projection of a library entry — never includes a path. */
export type PublicLegacyTitle = {
  contentId: string;
  label: string;
  runtimeKind: LegacyRuntimeKind;
  addedAt: string;
};

export type ArchiveBayLibrary = {
  titles: PublicLegacyTitle[];
  runtimeConfigured: boolean;
  activeLaunch: { contentId: string } | null;
};

export type ArchiveBayLaunchState =
  | { contentId: string; status: "running" }
  | { contentId: string; status: "exited"; exitCode: number | null }
  | { contentId: string; status: "error"; code: string };

export type ArchiveBayBridge = {
  list: () => Promise<ArchiveBayLibrary>;
  import: (input?: { label?: string }) => Promise<PublicLegacyTitle | null>;
  remove: (contentId: string) => Promise<boolean>;
  launch: (contentId: string) => Promise<{ contentId: string; status: "running" }>;
  getRuntimeStatus: () => Promise<{ configured: boolean }>;
  chooseRuntime: () => Promise<{ configured: boolean }>;
  onLaunchState: (listener: (state: ArchiveBayLaunchState) => void) => () => void;
};

type ArchiveBayWindow = Window & {
  axisDesktop?: {
    archiveBay?: ArchiveBayBridge;
  };
};

export function getArchiveBayBridge(): ArchiveBayBridge | null {
  if (typeof window === "undefined") return null;
  return (window as ArchiveBayWindow).axisDesktop?.archiveBay ?? null;
}
