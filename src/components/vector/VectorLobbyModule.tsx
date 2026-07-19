"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AxisChromePanel } from "@/components/ui/axis/AxisChromePanel";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { VectorArtworkPlate } from "@/components/vector/VectorArtworkPlate";
import { VectorSyncBadge } from "@/components/vector/VectorSyncBadge";
import { VECTOR_GAME_REGISTRY } from "@/lib/vector/registry";
import {
  resolveVectorMotionPreference,
  supportsVectorFullscreen,
} from "@/lib/vector/runtime";
import {
  DEFAULT_VECTOR_RUNTIME_SETTINGS,
  type VectorGameManifest,
  type VectorGamePersistenceSummary,
  type VectorLibraryActions,
  type VectorLocalDataState,
  type VectorOfflineStorageSummary,
  type VectorRuntimeSettings,
  type VectorSaveSummary,
} from "@/lib/vector/types";
import styles from "./Vector.module.css";

type Props = {
  summaries?: readonly VectorGamePersistenceSummary[];
  actions?: Partial<VectorLibraryActions>;
  settings?: VectorRuntimeSettings;
  onSettingsChange?: (settings: VectorRuntimeSettings) => void;
  localDataState?: VectorLocalDataState;
  offlineStorage?: VectorOfflineStorageSummary;
  ownerScope?: "account" | "anonymous";
};

type RestartTarget = {
  game: VectorGameManifest;
  save: VectorSaveSummary;
};

const SYNC_PRIORITY = {
  conflict: 6,
  error: 5,
  pending: 4,
  syncing: 3,
  "local-only": 2,
  synced: 1,
} as const;

function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return "Estimate unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLastPlayed(iso: string) {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function latestSave(summary?: VectorGamePersistenceSummary) {
  if (!summary?.saves.length) return undefined;
  return [...summary.saves].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function inputCapabilities(game: VectorGameManifest) {
  return (Object.entries(game.input) as [keyof VectorGameManifest["input"], boolean][])
    .filter(([, enabled]) => enabled)
    .map(([input]) => input)
    .join(" · ");
}

export function VectorLobbyModule({
  summaries = [],
  actions,
  settings,
  onSettingsChange,
  localDataState = { status: "ready" },
  offlineStorage,
  ownerScope,
}: Props) {
  const { toast } = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLElement>(null);
  const offlineRef = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState(VECTOR_GAME_REGISTRY[0].id);
  const [localSettings, setLocalSettings] = useState(DEFAULT_VECTOR_RUNTIME_SETTINGS);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [clearDataBusy, setClearDataBusy] = useState(false);
  const [clearDataError, setClearDataError] = useState<string | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setSystemReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const summaryByGame = useMemo(
    () => new Map(summaries.map((summary) => [summary.gameId, summary])),
    [summaries],
  );
  const offlineInstallByGame = useMemo(
    () => new Map((offlineStorage?.installs ?? []).map((install) => [install.gameId, install])),
    [offlineStorage?.installs],
  );
  const installableGames = useMemo(
    () => new Set(offlineStorage?.installableGameIds ?? []),
    [offlineStorage?.installableGameIds],
  );
  const selected = VECTOR_GAME_REGISTRY.find((game) => game.id === selectedId) ?? VECTOR_GAME_REGISTRY[0];
  const selectedSummary = summaryByGame.get(selected.id);
  const selectedSave = latestSave(selectedSummary);
  const editableSettings = settings === undefined || onSettingsChange !== undefined;
  const baseSettings = settings ?? localSettings;
  const resolvedSettings = {
    ...baseSettings,
    resolvedMotion: resolveVectorMotionPreference(
      baseSettings.motionPreference,
      systemReducedMotion,
    ),
  };

  const saves = useMemo(
    () => summaries
      .flatMap((summary) => summary.saves)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [summaries],
  );
  const conflictOnlySummaries = useMemo(
    () => summaries.filter((summary) => (
      summary.conflictCount > 0
      && !summary.saves.some((save) => save.conflictCount > 0)
      && summary.preferredConflictSlotId
    )),
    [summaries],
  );

  const aggregateSync = useMemo(() => {
    if (summaries.length === 0) return undefined;
    return [...summaries]
      .sort((a, b) => SYNC_PRIORITY[b.syncState] - SYNC_PRIORITY[a.syncState])[0]
      ?.syncState;
  }, [summaries]);

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

  const revealSection = (
    open: boolean,
    setOpen: (open: boolean) => void,
    ref: RefObject<HTMLElement | null>,
  ) => {
    const next = !open;
    setOpen(next);
    if (next) requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: resolvedSettings.resolvedMotion === "reduced" ? "auto" : "smooth", block: "nearest" }));
  };

  const toggleFullscreen = async () => {
    try {
      const root = rootRef.current;
      if (!root || !supportsVectorFullscreen(document, root)) {
        toast("Fullscreen could not be changed in this browser.", "error", "VECTOR");
        return;
      }
      if (document.fullscreenElement === root) {
        await document.exitFullscreen();
      } else {
        await root.requestFullscreen();
      }
    } catch {
      toast("Fullscreen could not be changed in this browser.", "error", "VECTOR");
    }
  };

  const syncPending = () => {
    const pending = summaries.filter((summary) =>
      summary.syncState === "pending" || summary.syncState === "error",
    );
    if (!actions?.onSync || pending.length === 0) return;
    for (const summary of pending) actions.onSync(summary.gameId);
  };

  const closeClearData = () => {
    if (clearDataBusy) return;
    setClearDataError(null);
    setClearDataOpen(false);
  };

  const confirmClearData = async () => {
    if (!actions?.onClearOwnerData || clearDataBusy) return;
    setClearDataBusy(true);
    setClearDataError(null);
    try {
      await actions.onClearOwnerData();
      setClearDataOpen(false);
    } catch (error) {
      setClearDataError(
        error instanceof Error && /^VECTOR_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "VECTOR_CLEAR_OWNER_FAILED",
      );
    } finally {
      setClearDataBusy(false);
    }
  };

  const localStateCallout = localDataState.status === "loading"
    ? {
        kind: "loading" as const,
        title: "Loading owner-scoped VECTOR records.",
        message: localDataState.message ?? "The catalog remains available while local saves and installs are inspected.",
      }
    : localDataState.status === "unavailable"
      ? {
          kind: "disconnected" as const,
          title: "Local VECTOR storage is unavailable.",
          message: localDataState.message,
        }
      : localDataState.status === "quota"
        ? {
            kind: "error" as const,
            title: "Local VECTOR storage quota was reached.",
            message: localDataState.message,
          }
        : localDataState.status === "error"
          ? {
              kind: "error" as const,
              title: "VECTOR records could not be loaded.",
              message: localDataState.message,
            }
          : null;

  const selectedHasConflict = Boolean(selectedSummary?.conflictCount);
  const selectedCanPlay = selected.status === "available"
    && !selectedHasConflict
    && Boolean(actions?.onPlay);
  const selectedCanResume = selected.status === "available"
    && !selectedHasConflict
    && Boolean(selectedSave?.canResume)
    && Boolean(actions?.onResume);

  return (
    <div
      ref={rootRef}
      className={styles.vectorRoot}
      data-motion={resolvedSettings.resolvedMotion}
      data-testid="vector-lobby"
    >
      <header className={styles.lobbyHeader}>
        <div>
          <div className={styles.eyebrow}>Labs / Interactive systems</div>
          <h1>VECTOR</h1>
          <p>Interactive systems, simulations, and games built as complete Axis systems.</p>
        </div>
        <div className={styles.headerReadout} aria-label="VECTOR platform status">
          <span>Catalog</span>
          <strong>9 planned systems</strong>
          <span>Runtime</span>
          <strong>Platform foundation</strong>
        </div>
      </header>

      <AxisChromePanel className={styles.utilityStrip}>
        <label className={styles.volumeControl}>
          <span>Master volume</span>
          <input
            aria-label="Master volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={resolvedSettings.volume}
            data-testid="vector-volume"
            disabled={!editableSettings}
            onChange={(event) => updateSettings({ volume: Number(event.target.value) })}
          />
          <output>{Math.round(resolvedSettings.volume * 100)}%</output>
        </label>
        <Button
          type="button"
          variant="ghost"
          className={styles.utilityButton}
          data-testid="vector-mute"
          disabled={!editableSettings}
          aria-pressed={resolvedSettings.muted}
          onClick={() => updateSettings({ muted: !resolvedSettings.muted })}
        >
          {resolvedSettings.muted ? "Unmute" : "Mute"}
        </Button>
        <label className={styles.motionControl}>
          <span>Motion</span>
          <select
            aria-label="Motion preference"
            value={resolvedSettings.motionPreference}
            data-testid="vector-motion"
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
          type="button"
          variant="ghost"
          className={styles.utilityButton}
          data-testid="vector-low-power"
          disabled={!editableSettings}
          aria-pressed={resolvedSettings.lowPower}
          onClick={() => updateSettings({ lowPower: !resolvedSettings.lowPower })}
        >
          {resolvedSettings.lowPower ? "60 fps mode" : "Low power"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={styles.utilityButton}
          data-testid="vector-controls-toggle"
          aria-expanded={controlsOpen}
          onClick={() => revealSection(controlsOpen, setControlsOpen, controlsRef)}
        >
          Controls
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={styles.utilityButton}
          data-testid="vector-offline-toggle"
          aria-expanded={offlineOpen}
          onClick={() => revealSection(offlineOpen, setOfflineOpen, offlineRef)}
        >
          Offline storage
        </Button>
        <button
          type="button"
          className={styles.syncReadout}
          data-testid="vector-sync-action"
          disabled={
            localDataState.status !== "ready"
            || !actions?.onSync
            || !summaries.some((summary) => summary.syncState === "pending" || summary.syncState === "error")
          }
          onClick={syncPending}
          title={actions?.onSync ? "Synchronize pending VECTOR records" : "Synchronization action is unavailable"}
        >
          <span>Sync health</span>
          <VectorSyncBadge state={aggregateSync} testId="vector-sync-status" />
        </button>
        <Button
          type="button"
          variant="ghost"
          className={styles.utilityButton}
          data-testid="vector-fullscreen"
          aria-pressed={isFullscreen}
          onClick={() => void toggleFullscreen()}
        >
          {isFullscreen ? "Exit full screen" : "Full screen"}
        </Button>
        <Link
          className={styles.secondaryLink}
          href="/vector/archive-bay"
          data-testid="vector-archive-bay-link"
          title="Launch legacy titles you already own (desktop app only)"
        >
          Archive Bay · desktop only
        </Link>
      </AxisChromePanel>

      <div
        data-testid="vector-data-state"
        data-state={localDataState.status}
        hidden={!localStateCallout}
      >
        {localStateCallout ? (
          <StatusCallout kind={localStateCallout.kind} title={localStateCallout.title}>
            {localStateCallout.message}
          </StatusCallout>
        ) : null}
      </div>

      <section className={styles.instrumentDeck} aria-labelledby="vector-featured-title">
        <AxisReflectiveCard className={styles.featuredDisplay}>
          <VectorArtworkPlate game={selected} />
          <div className={styles.featuredCopy}>
            <div className={styles.featuredStatus}>
              <span>{selected.engine === "native" ? "Native DOM / Canvas" : selected.engine}</span>
              <span>{selected.targetFrameRate} fps target</span>
              <span>{inputCapabilities(selected)}</span>
              <VectorSyncBadge state={selectedSummary?.syncState} />
            </div>
            <h2 id="vector-featured-title">{selected.title}</h2>
            <p className={styles.featuredSubtitle}>{selected.subtitle}</p>
            <p>{selected.shortDescription}</p>
            {selectedSave ? (
              <div className={styles.saveSummary}>
                <span>{selectedSave.checkpointLabel ?? `Slot ${selectedSave.slotId}`}</span>
                <span>Saved {formatLastPlayed(selectedSave.updatedAt)}</span>
                <span>{selectedSummary?.pendingEventCount ?? 0} pending events</span>
              </div>
            ) : (
              <div className={styles.saveSummary}>
                <span>No real save record</span>
                <span>Play and resume remain unavailable</span>
              </div>
            )}
            <div className={styles.featuredActions}>
              <Link className={styles.primaryLink} href={`/vector/${selected.slug}`}>
                Open game brief
              </Link>
              {selectedSummary?.conflictCount
                && selectedSummary.preferredConflictSlotId
                && actions?.onOpenConflicts ? (
                  <Button
                    type="button"
                    variant="primary"
                    data-testid="vector-featured-conflicts"
                    onClick={() => actions.onOpenConflicts?.(
                      selected.id,
                      selectedSummary.preferredConflictSlotId!,
                    )}
                  >
                    Resolve {selectedSummary.conflictCount} {selectedSummary.conflictCount === 1 ? "conflict" : "conflicts"}
                  </Button>
                ) : selectedCanPlay ? (
                  <Button variant="primary" onClick={() => actions?.onPlay?.(selected.id)}>Play</Button>
                ) : (
                  <Button variant="primary" disabled>Planned</Button>
                )}
              {selectedCanResume && selectedSave ? (
                <Button onClick={() => actions?.onResume?.(selected.id, selectedSave.slotId)}>Resume</Button>
              ) : null}
              {selected.status === "available" && !selectedHasConflict && selectedSave && actions?.onRestart ? (
                <Button variant="danger" onClick={() => setRestartTarget({ game: selected, save: selectedSave })}>
                  Restart
                </Button>
              ) : null}
            </div>
          </div>
        </AxisReflectiveCard>

        <AxisChromePanel className={styles.libraryRail}>
          <div className={styles.sectionHeading}>
            <div>
              <span>Library rail</span>
              <h2>Launch catalog</h2>
            </div>
            <strong>{VECTOR_GAME_REGISTRY.length.toString().padStart(2, "0")}</strong>
          </div>
          <div className={styles.gameList} role="list" aria-label="VECTOR games">
            {VECTOR_GAME_REGISTRY.map((game) => {
              const summary = summaryByGame.get(game.id);
              const save = latestSave(summary);
              return (
                <div key={game.id} role="listitem">
                  <button
                    type="button"
                    className={`${styles.gameCard}${selected.id === game.id ? ` ${styles.gameCardSelected}` : ""}`}
                    onClick={() => setSelectedId(game.id)}
                    aria-pressed={selected.id === game.id}
                    aria-label={`${game.title}: ${game.status}`}
                    data-testid={`vector-game-card-${game.slug}`}
                    data-game-slug={game.slug}
                    data-game-status={game.status}
                  >
                    <VectorArtworkPlate game={game} compact />
                    <span className={styles.gameCardCopy}>
                      <strong>{game.title}</strong>
                      <span>{game.shortDescription}</span>
                      <span className={styles.capabilityLine}>{inputCapabilities(game)}</span>
                      <span className={styles.capabilityLine}>
                        {save ? `Saved ${formatLastPlayed(save.updatedAt)}` : "No save record"}
                        {" · "}
                        {summary ? summary.install.state : "No install record"}
                      </span>
                      <span className={styles.gameCardMeta}>
                        <b>{game.status}</b>
                        <VectorSyncBadge state={summary?.syncState} />
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </AxisChromePanel>
      </section>

      <section className={styles.continueSection} aria-labelledby="vector-continue-title">
        <div className={styles.sectionHeading}>
          <div>
            <span>Continue rail</span>
            <h2 id="vector-continue-title">Verified local activity</h2>
          </div>
          <strong>{(saves.length + conflictOnlySummaries.length).toString().padStart(2, "0")}</strong>
        </div>
        {localDataState.status !== "ready" ? (
          <StatusCallout
            kind={localDataState.status === "loading" ? "loading" : "disconnected"}
            title="Verified activity is not available yet."
          >
            Continue cards remain withheld until owner-scoped local records load successfully.
          </StatusCallout>
        ) : saves.length === 0 && conflictOnlySummaries.length === 0 ? (
          <StatusCallout kind="empty" title="No VECTOR saves exist on this owner profile.">
            Continue, pending-save, and conflict cards appear only from real IndexedDB or synchronized records.
          </StatusCallout>
        ) : (
          <div className={styles.saveStripList}>
            {conflictOnlySummaries.map((summary) => {
              const game = VECTOR_GAME_REGISTRY.find((item) => item.id === summary.gameId);
              if (!game || !summary.preferredConflictSlotId) return null;
              return (
                <article key={`${summary.gameId}:conflict-only`} className={styles.saveStrip}>
                  <VectorArtworkPlate game={game} compact />
                  <div>
                    <strong>{game.title}</strong>
                    <span>Quarantined save branch</span>
                    <span>No state from this record will be hydrated until you choose.</span>
                  </div>
                  <VectorSyncBadge state="conflict" />
                  {actions?.onOpenConflicts ? (
                    <Button onClick={() => actions.onOpenConflicts?.(
                      game.id,
                      summary.preferredConflictSlotId!,
                    )}>
                      Resolve {summary.conflictCount}
                    </Button>
                  ) : null}
                </article>
              );
            })}
            {saves.map((save) => {
              const game = VECTOR_GAME_REGISTRY.find((item) => item.id === save.gameId);
              if (!game) return null;
              return (
                <article key={`${save.gameId}:${save.slotId}`} className={styles.saveStrip}>
                  <VectorArtworkPlate game={game} compact />
                  <div>
                    <strong>{game.title}</strong>
                    <span>{save.checkpointLabel ?? `Slot ${save.slotId}`}</span>
                    <span>Revision {save.localRevision} · {formatLastPlayed(save.updatedAt)}</span>
                  </div>
                  <VectorSyncBadge state={save.syncState} />
                  {save.conflictCount > 0 && actions?.onOpenConflicts ? (
                    <Button onClick={() => actions.onOpenConflicts?.(game.id, save.slotId)}>
                      Resolve {save.conflictCount}
                    </Button>
                  ) : save.canResume && game.status === "available" && actions?.onResume ? (
                    <Button onClick={() => actions.onResume?.(game.id, save.slotId)}>Resume</Button>
                  ) : (
                    <Link className={styles.secondaryLink} href={`/vector/${game.slug}`}>Inspect</Link>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {controlsOpen ? (
        <section
          ref={controlsRef}
          className={styles.utilityPanel}
          aria-labelledby="vector-controls-title"
          data-testid="vector-controls-panel"
        >
          <div className={styles.sectionHeading}>
            <div>
              <span>Input map</span>
              <h2 id="vector-controls-title">{selected.title} planned controls</h2>
            </div>
          </div>
          <div className={styles.controlGrid}>
            {selected.controls.map((descriptor) => (
              <article key={descriptor.id}>
                <span>{descriptor.input}</span>
                <strong>{descriptor.label}</strong>
                <p>{descriptor.description}</p>
                <code>{descriptor.bindings.join(" / ")}</code>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {offlineOpen ? (
        <section
          ref={offlineRef}
          className={styles.utilityPanel}
          aria-labelledby="vector-offline-title"
          data-testid="vector-offline-panel"
        >
          <div className={styles.sectionHeading}>
            <div>
              <span>Cache boundary</span>
              <h2 id="vector-offline-title">Per-game offline storage</h2>
            </div>
          </div>
          <StatusCallout
            kind="info"
            title={installableGames.size === 0
              ? "No deployed title claims an offline package."
              : `${installableGames.size} verified offline ${installableGames.size === 1 ? "package is" : "packages are"} available.`}
          >
            Install controls activate only when this exact deploy publishes a digest-bound manifest for a complete playable build.
          </StatusCallout>
          <div className={styles.storageReadout} data-testid="vector-storage-status">
            <div>
              <span>Browser support</span>
              <strong>
                {offlineStorage?.loading
                  ? "Inspecting"
                  : offlineStorage?.supported
                    ? "Available"
                    : "Unavailable"}
              </strong>
            </div>
            <div>
              <span>Used / quota</span>
              <strong>
                {formatBytes(offlineStorage?.usage)}
                {" / "}
                {formatBytes(offlineStorage?.quota)}
              </strong>
            </div>
            <div>
              <span>Retention</span>
              <strong>
                {offlineStorage?.persisted === true
                  ? "Persistent"
                  : offlineStorage?.persisted === false
                    ? "Best effort"
                    : "Unknown"}
              </strong>
            </div>
            <div>
              <span>Owner namespace</span>
              <strong>
                {ownerScope === "account"
                  ? "Signed-in account"
                  : ownerScope === "anonymous"
                    ? "Anonymous device"
                    : "Loading"}
              </strong>
            </div>
          </div>
          {offlineStorage?.error ? (
            <StatusCallout kind="error" title="Storage telemetry failed.">
              {offlineStorage.error}
            </StatusCallout>
          ) : null}
          <div className={styles.storageActions}>
            <Button
              type="button"
              data-testid="vector-storage-persist"
              disabled={
                !actions?.onRequestPersistentStorage
                || !offlineStorage?.supported
                || offlineStorage.loading
                || offlineStorage.persisted === true
              }
              onClick={() => actions?.onRequestPersistentStorage?.()}
            >
              {offlineStorage?.persisted === true ? "Persistent storage active" : "Request persistent storage"}
            </Button>
            <Button
              type="button"
              variant="danger"
              data-testid="vector-clear-data"
              disabled={!actions?.onClearOwnerData || localDataState.status !== "ready"}
              onClick={() => {
                setClearDataError(null);
                setClearDataOpen(true);
              }}
            >
              Clear this owner&apos;s VECTOR data
            </Button>
          </div>
          <div className={styles.offlineList}>
            {VECTOR_GAME_REGISTRY.map((game) => {
              const install = offlineInstallByGame.get(game.id);
              const busy = offlineStorage?.busy;
              const thisBusy = busy?.gameId === game.id ? busy.operation : null;
              const actionsBusy = busy !== null && busy !== undefined;
              const statusReady = Boolean(
                offlineStorage?.statusAvailable && offlineStorage.supported,
              );
              const showInstall = Boolean(
                statusReady
                && installableGames.has(game.id)
                && actions?.onInstall
              );
              const showRemove = Boolean(
                statusReady
                && install?.state === "installed"
                && actions?.onRemoveInstall
              );
              const stateLabel = thisBusy === "install"
                ? "installing"
                : thisBusy === "remove"
                  ? "removing"
                  : !offlineStorage?.statusAvailable
                    ? "status unavailable"
                    : install?.state ?? "not-installed";
              return (
                <article key={game.id}>
                  <div>
                    <strong>{game.title}</strong>
                    <span>
                      {stateLabel} · {formatBytes(
                        install?.estimatedBytes ?? game.offline.estimatedBytes,
                      )}
                    </span>
                  </div>
                  {thisBusy ? (
                    <Button disabled>
                      {thisBusy === "install" ? "Installing…" : "Removing…"}
                    </Button>
                  ) : showRemove ? (
                    <Button
                      variant="danger"
                      disabled={actionsBusy}
                      onClick={() => actions?.onRemoveInstall?.(game.id)}
                    >
                      Remove
                    </Button>
                  ) : showInstall ? (
                    <Button
                      disabled={actionsBusy}
                      onClick={() => actions?.onInstall?.(game.id)}
                    >
                      Install
                    </Button>
                  ) : (
                    <span className={styles.plannedLabel}>Unavailable</span>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className={styles.detailSection} aria-labelledby="vector-detail-title">
        <VectorArtworkPlate game={selected} />
        <div className={styles.detailCopy}>
          <div className={styles.eyebrow}>Selected system / {selected.id}</div>
          <h2 id="vector-detail-title">{selected.title}</h2>
          <p>{selected.description}</p>
          <dl className={styles.detailGrid}>
            <div><dt>Version</dt><dd>{selected.version} · planned</dd></div>
            <div><dt>Save schema</dt><dd>v{selected.saveSchemaVersion}</dd></div>
            <div><dt>Minimum viewport</dt><dd>{selected.minimumViewport.width} × {selected.minimumViewport.height}</dd></div>
            <div><dt>Orientation</dt><dd>{selected.orientation}</dd></div>
            <div><dt>Save contract</dt><dd>{selected.save.local ? "Local" : "No local"} · {selected.save.cloud ? "cloud planned" : "no cloud"}</dd></div>
            <div><dt>Offline estimate</dt><dd>{formatBytes(selected.offline.estimatedBytes)}</dd></div>
            <div><dt>Score model</dt><dd>{selected.score.label}</dd></div>
            <div><dt>Achievements</dt><dd>{selected.score.achievements ? "Planned" : "Not supported"}</dd></div>
            <div><dt>Leaderboard</dt><dd>{selected.score.leaderboard ? "Planned" : "Not supported"}</dd></div>
            <div><dt>Audio</dt><dd>{selected.audio.available ? selected.audio.channels.join(", ") : "Unavailable"}</dd></div>
          </dl>
          <StatusCallout kind="info" title={selected.availabilityReason}>
            {selected.accessibilityDescription}
          </StatusCallout>
        </div>
      </section>

      <Modal
        open={restartTarget !== null}
        onClose={() => setRestartTarget(null)}
        title="Restart VECTOR save"
        motion={resolvedSettings.resolvedMotion}
        footer={(
          <>
            <Button onClick={() => setRestartTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!restartTarget) return;
                actions?.onRestart?.(restartTarget.game.id, restartTarget.save.slotId);
                setRestartTarget(null);
              }}
            >
              Restart
            </Button>
          </>
        )}
      >
        <p>
          Restart {restartTarget?.game.title ?? "this game"} from its initial state?
          Existing save history remains governed by the persistence conflict policy.
        </p>
      </Modal>
      <Modal
        open={clearDataOpen}
        onClose={closeClearData}
        title="Clear owner-scoped VECTOR data"
        motion={resolvedSettings.resolvedMotion}
        busy={clearDataBusy}
        footer={(
          <>
            <Button disabled={clearDataBusy} onClick={closeClearData}>Cancel</Button>
            <Button
              variant="danger"
              disabled={clearDataBusy || !actions?.onClearOwnerData}
              onClick={() => void confirmClearData()}
            >
              {clearDataBusy ? "Clearing…" : "Clear local records"}
            </Button>
          </>
        )}
      >
        <p>
          Remove this owner namespace&apos;s local profiles, saves, pending events,
          and conflicts from this browser? Public offline packages remain
          device-scoped and can be removed separately.
        </p>
        {clearDataError ? (
          <StatusCallout kind="error" title="Owner-scoped data was not cleared.">
            {clearDataError}
          </StatusCallout>
        ) : null}
      </Modal>
    </div>
  );
}
