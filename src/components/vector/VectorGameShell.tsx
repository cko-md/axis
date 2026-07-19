"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AxisChromePanel } from "@/components/ui/axis/AxisChromePanel";
import { Button } from "@/components/ui/Button";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { GameRuntimeHost } from "@/components/vector/GameRuntimeHost";
import { VectorArtworkPlate } from "@/components/vector/VectorArtworkPlate";
import { VectorSyncBadge } from "@/components/vector/VectorSyncBadge";
import {
  DEFAULT_VECTOR_RUNTIME_SETTINGS,
  type VectorGameManifest,
  type VectorGamePersistenceSummary,
  type VectorGameScoreInput,
  type VectorLibraryActions,
  type VectorRuntimeEvent,
  type VectorRuntimeSettings,
  type VectorSaveReason,
  type VectorSerializedSave,
} from "@/lib/vector/types";
import {
  getVectorRuntimeUnsupportedReason,
  resolveVectorMotionPreference,
  type VectorRuntimeViewport,
} from "@/lib/vector/runtime";
import type { VectorSaveMigrationResult } from "@/lib/vector/merge";
import styles from "./Vector.module.css";

type Props = {
  manifest: VectorGameManifest;
  summary?: VectorGamePersistenceSummary;
  actions?: Partial<VectorLibraryActions>;
  settings?: VectorRuntimeSettings;
  runtimeReady: boolean;
  initialSave?: VectorSerializedSave | null;
  registerOwnerTransitionBarrier?: (
    barrier: () => void | Promise<void>,
  ) => () => void;
  onSettingsChange?: (settings: VectorRuntimeSettings) => void;
  onSave?: (save: VectorSerializedSave, reason: VectorSaveReason) => void | Promise<void>;
  onSaveMigrationFailure?: (
    code: Extract<VectorSaveMigrationResult, { ok: false }>["code"],
  ) => void | Promise<void>;
  onEvent?: (event: VectorRuntimeEvent) => void;
  onRecordScore?: (input: VectorGameScoreInput) => void | Promise<void>;
  onGetBestScore?: (input: { mode: string; challengeId: string | null }) => Promise<number | null>;
};

type RuntimeGate = {
  testId: string;
  title: string;
  message: string;
  action: string;
  onAction?: () => void;
};

function formatBytes(bytes: number | null) {
  if (bytes === null) return "Estimate unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VectorGameShell({
  manifest,
  summary,
  actions,
  settings,
  runtimeReady,
  initialSave = null,
  registerOwnerTransitionBarrier,
  onSettingsChange,
  onSave,
  onSaveMigrationFailure,
  onEvent,
  onRecordScore,
  onGetBestScore,
}: Props) {
  const [localSettings, setLocalSettings] = useState(DEFAULT_VECTOR_RUNTIME_SETTINGS);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [runtimeViewport, setRuntimeViewport] = useState<VectorRuntimeViewport | null>(null);
  const runtimeFrameRef = useRef<HTMLDivElement>(null);
  const baseSettings = settings ?? localSettings;
  const editableSettings = settings === undefined || onSettingsChange !== undefined;
  const runtimeSettings = {
    ...baseSettings,
    resolvedMotion: resolveVectorMotionPreference(
      baseSettings.motionPreference,
      systemReducedMotion,
    ),
  };

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setSystemReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const frame = runtimeFrameRef.current;
    if (!frame) return;
    const sync = () => {
      const bounds = frame.getBoundingClientRect();
      setRuntimeViewport({
        width: Math.max(0, Math.floor(bounds.width)),
        height: Math.max(0, Math.floor(bounds.height)),
      });
    };
    sync();
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(sync)
      : null;
    observer?.observe(frame);
    window.addEventListener("resize", sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  const updateSettings = (patch: Partial<VectorRuntimeSettings>) => {
    if (!editableSettings) return;
    const nextBase = { ...baseSettings, ...patch };
    const next = {
      ...nextBase,
      volume: Math.min(1, Math.max(0, nextBase.volume)),
      resolvedMotion: resolveVectorMotionPreference(
        nextBase.motionPreference,
        systemReducedMotion,
      ),
    };
    setLocalSettings(next);
    onSettingsChange?.(next);
  };

  const installed = summary?.install.state === "installed";
  const canInstall = manifest.status === "available"
    && manifest.offline.available
    && Boolean(actions?.onInstall);
  const canRemove = installed && Boolean(actions?.onRemoveInstall);
  const hasOpenConflict = Boolean(summary?.conflictCount);
  const unsupportedReason = runtimeViewport
    ? getVectorRuntimeUnsupportedReason({
        minimumViewport: manifest.minimumViewport,
        orientation: manifest.orientation,
        viewport: runtimeViewport,
      })
    : null;
  const runtimeCanMount = (
    manifest.status === "available"
    && runtimeReady
    && !hasOpenConflict
    && runtimeViewport !== null
    && unsupportedReason === null
  );
  const runtimeGate: RuntimeGate | null = hasOpenConflict
    ? {
        testId: "vector-game-conflict",
        title: "Resolve the preserved save branches before this runtime starts.",
        message: "VECTOR blocks every slot for this game while an open conflict exists, so neither branch can run or be overwritten by a new session.",
        action: "Resolve conflict",
        ...(summary?.preferredConflictSlotId && actions?.onOpenConflicts ? {
          onAction: () => actions.onOpenConflicts?.(
            manifest.id,
            summary.preferredConflictSlotId!,
          ),
        } : {}),
      }
    : manifest.status === "planned"
      ? {
        testId: "vector-game-planned",
        title: manifest.availabilityReason,
        message: "VECTOR enables a title only after its mechanic, save path, controls, error states, and route-isolated loader are complete.",
        action: "Play unavailable",
      }
      : manifest.status === "maintenance"
        ? {
          testId: "vector-game-maintenance",
          title: manifest.availabilityReason,
          message: "The runtime remains disabled until its complete workflow passes validation again.",
          action: "Temporarily unavailable",
        }
        : !runtimeReady
          ? {
            testId: "vector-game-data-pending",
            title: "Owner-scoped save data must load before this runtime starts.",
            message: "VECTOR is withholding the engine so an existing save cannot be skipped or overwritten by a fresh session.",
            action: "Waiting for save data",
          }
          : runtimeViewport === null
            ? {
              testId: "vector-game-compatibility-pending",
              title: "Checking runtime compatibility.",
              message: "VECTOR is measuring this viewport before loading the game engine.",
              action: "Checking viewport",
            }
            : unsupportedReason
              ? {
                testId: "vector-game-unsupported",
                title: "This viewport is not supported.",
                message: unsupportedReason,
                action: "Runtime unsupported",
              }
              : null;

  return (
    <div
      className={styles.gameShell}
      data-motion={runtimeSettings.resolvedMotion}
      data-testid="vector-game-shell"
      data-game-slug={manifest.slug}
      data-game-status={manifest.status}
    >
      <div className={styles.gameRouteHeader}>
        <Link href="/vector" className={styles.backLink}>← VECTOR library</Link>
        <div className={styles.gameRouteReadout}>
          <span>{manifest.engine === "native" ? "Native DOM / Canvas" : manifest.engine}</span>
          <span>Build {manifest.version}</span>
          <VectorSyncBadge state={summary?.syncState} />
        </div>
      </div>

      <section className={styles.gameHero}>
        <VectorArtworkPlate game={manifest} />
        <div className={styles.gameHeroCopy}>
          <div className={styles.eyebrow}>VECTOR / {manifest.id}</div>
          <h1>{manifest.title}</h1>
          <p className={styles.gameSubtitle}>{manifest.subtitle}</p>
          <p>{manifest.description}</p>
          {manifest.status === "planned" ? (
            <StatusCallout kind="info" title="This system is planned, not playable.">
              {manifest.availabilityReason}
            </StatusCallout>
          ) : manifest.status === "maintenance" ? (
            <StatusCallout kind="disconnected" title="This system is temporarily unavailable.">
              The game remains disabled until its complete runtime passes validation again.
            </StatusCallout>
          ) : null}
        </div>
      </section>

      <AxisChromePanel className={styles.gameUtilityBar}>
        <label className={styles.volumeControl}>
          <span>Master volume</span>
          <input
            aria-label="Master volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={runtimeSettings.volume}
            data-testid="vector-game-volume"
            disabled={!editableSettings}
            onChange={(event) => updateSettings({ volume: Number(event.target.value) })}
          />
          <output>{Math.round(runtimeSettings.volume * 100)}%</output>
        </label>
        <Button
          variant="ghost"
          data-testid="vector-game-mute"
          disabled={!editableSettings}
          aria-pressed={runtimeSettings.muted}
          onClick={() => updateSettings({ muted: !runtimeSettings.muted })}
        >
          {runtimeSettings.muted ? "Unmute" : "Mute"}
        </Button>
        <label className={styles.motionControl}>
          <span>Motion</span>
          <select
            aria-label="Motion preference"
            value={runtimeSettings.motionPreference}
            data-testid="vector-game-motion"
            disabled={!editableSettings}
            onChange={(event) => updateSettings({
              motionPreference: event.target.value as VectorRuntimeSettings["motionPreference"],
            })}
          >
            <option value="system">System</option>
            <option value="standard">Standard</option>
            <option value="reduced">Reduced</option>
          </select>
        </label>
        <Button
          variant="ghost"
          data-testid="vector-game-low-power"
          disabled={!editableSettings}
          aria-pressed={runtimeSettings.lowPower}
          onClick={() => updateSettings({ lowPower: !runtimeSettings.lowPower })}
        >
          {runtimeSettings.lowPower ? "60 fps mode" : "Low power"}
        </Button>
        {canRemove ? (
          <Button variant="danger" onClick={() => actions?.onRemoveInstall?.(manifest.id)}>
            Remove offline copy
          </Button>
        ) : canInstall ? (
          <Button onClick={() => actions?.onInstall?.(manifest.id)}>Install offline</Button>
        ) : (
          <Button disabled title={manifest.offline.compatibility}>Offline unavailable</Button>
        )}
      </AxisChromePanel>

      <div
        ref={runtimeFrameRef}
        className={styles.runtimeViewportFrame}
        data-testid="vector-runtime-viewport"
      >
        {runtimeCanMount ? (
          <GameRuntimeHost
            manifest={manifest}
            settings={runtimeSettings}
            initialSave={initialSave}
            registerOwnerTransitionBarrier={registerOwnerTransitionBarrier}
            onSave={onSave}
            onSaveMigrationFailure={onSaveMigrationFailure}
            onEvent={onEvent}
            onRecordScore={onRecordScore}
            onGetBestScore={onGetBestScore}
          />
        ) : runtimeGate ? (
          <section
            className={styles.plannedStage}
            aria-label={`${manifest.title} unavailable play surface`}
            data-testid={runtimeGate.testId}
          >
            <VectorArtworkPlate game={manifest} />
            <div>
              <span>Playable surface withheld</span>
              <strong>{runtimeGate.title}</strong>
              <p>{runtimeGate.message}</p>
              <Button
                variant="primary"
                disabled={!runtimeGate.onAction}
                data-testid={runtimeGate.onAction ? "vector-game-conflict-resolve" : undefined}
                onClick={runtimeGate.onAction}
              >
                {runtimeGate.action}
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      <section className={styles.gameInformationGrid}>
        <AxisChromePanel className={styles.gameInfoPanel}>
          <div className={styles.sectionHeading}>
            <div><span>Input map</span><h2>Controls</h2></div>
            <strong>{manifest.controls.length.toString().padStart(2, "0")}</strong>
          </div>
          <div className={styles.controlGrid}>
            {manifest.controls.map((descriptor) => (
              <article key={descriptor.id}>
                <span>{descriptor.input}</span>
                <strong>{descriptor.label}</strong>
                <p>{descriptor.description}</p>
                <code>{descriptor.bindings.join(" / ")}</code>
              </article>
            ))}
          </div>
        </AxisChromePanel>

        <AxisChromePanel className={styles.gameInfoPanel}>
          <div className={styles.sectionHeading}>
            <div><span>Persistence</span><h2>Save records</h2></div>
            <strong>{(summary?.saves.length ?? 0).toString().padStart(2, "0")}</strong>
          </div>
          {!summary?.saves.length ? (
            <div className={styles.emptyPersistenceState}>
              <StatusCallout
                kind={summary?.conflictCount ? "error" : "empty"}
                title={summary?.conflictCount
                  ? "A save branch is quarantined."
                  : "No local save record is loaded."}
              >
                {summary?.conflictCount
                  ? "VECTOR withheld checksum-invalid or divergent state from the runtime. Resolve or export the preserved branches explicitly."
                  : "A save slot appears only after the game writes a verified IndexedDB snapshot."}
              </StatusCallout>
              {summary?.conflictCount
                && summary.preferredConflictSlotId
                && actions?.onOpenConflicts ? (
                  <Button onClick={() => actions.onOpenConflicts?.(
                    manifest.id,
                    summary.preferredConflictSlotId!,
                  )}>
                    Resolve {summary.conflictCount} {summary.conflictCount === 1 ? "conflict" : "conflicts"}
                  </Button>
                ) : null}
            </div>
          ) : (
            <div className={styles.saveSlotList}>
              {summary.saves.map((save) => (
                <article key={save.slotId}>
                  <div>
                    <strong>{save.checkpointLabel ?? `Slot ${save.slotId}`}</strong>
                    <span>Local revision {save.localRevision}</span>
                  </div>
                  <VectorSyncBadge state={save.syncState} />
                  {save.conflictCount > 0 && actions?.onOpenConflicts ? (
                    <Button onClick={() => actions.onOpenConflicts?.(manifest.id, save.slotId)}>
                      Resolve {save.conflictCount}
                    </Button>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </AxisChromePanel>

        <AxisChromePanel className={styles.gameInfoPanel}>
          <div className={styles.sectionHeading}>
            <div><span>Compatibility</span><h2>Runtime contract</h2></div>
          </div>
          <dl className={styles.detailGrid}>
            <div><dt>Viewport</dt><dd>{manifest.minimumViewport.width} × {manifest.minimumViewport.height}</dd></div>
            <div><dt>Orientation</dt><dd>{manifest.orientation}</dd></div>
            <div><dt>Target</dt><dd>{manifest.targetFrameRate} fps</dd></div>
            <div><dt>Save schema</dt><dd>v{manifest.saveSchemaVersion}</dd></div>
            <div><dt>Audio</dt><dd>{manifest.audio.available ? manifest.audio.channels.join(", ") : "Unavailable"}</dd></div>
            <div><dt>Offline size</dt><dd>{formatBytes(manifest.offline.estimatedBytes)}</dd></div>
            <div><dt>Score model</dt><dd>{manifest.score.label}</dd></div>
            <div><dt>Achievements</dt><dd>{manifest.score.achievements ? "Planned" : "Not supported"}</dd></div>
            <div><dt>Leaderboard</dt><dd>{manifest.score.leaderboard ? "Planned" : "Not supported"}</dd></div>
            <div><dt>Save slots</dt><dd>{manifest.save.slots}</dd></div>
          </dl>
          <p className={styles.accessibilityNote}>{manifest.accessibilityDescription}</p>
        </AxisChromePanel>
      </section>
    </div>
  );
}
