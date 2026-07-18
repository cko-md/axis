"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { VectorAdoptionModal } from "@/components/vector/VectorAdoptionModal";
import { VectorConflictModal } from "@/components/vector/VectorConflictModal";
import { VectorGameShell } from "@/components/vector/VectorGameShell";
import { useVectorPlatform } from "@/hooks/useVectorPlatform";
import { compareVectorText } from "@/lib/vector/checksum";
import { requireVectorGame } from "@/lib/vector/registry";
import type { VectorGameSlug, VectorSerializedSave } from "@/lib/vector/types";
import { selectVectorHydratableSave } from "@/lib/vector/view-model";
import styles from "./Vector.module.css";

export function VectorGamePlatform({ gameId }: { gameId: VectorGameSlug }) {
  const manifest = requireVectorGame(gameId);
  const { toast } = useToast();
  const platform = useVectorPlatform({ reconcileOnReconnect: false });
  const lastErrorRef = useRef<string | null>(null);
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const summary = platform.summaries.find((candidate) => candidate.gameId === manifest.id);
  const slotId = summary?.preferredSlotId ?? "main";
  const selectedConflict = platform.conflicts.find(
    (conflict) => conflict.id === selectedConflictId && conflict.status === "open",
  ) ?? null;
  const selectedSave = useMemo(() => (
    selectVectorHydratableSave({
      gameId: manifest.id,
      preferredSlotId: summary?.preferredSlotId,
      saves: platform.saves,
      conflicts: platform.conflicts,
    })
  ), [manifest.id, platform.conflicts, platform.saves, summary?.preferredSlotId]);
  const initialSave = useMemo<VectorSerializedSave | null>(() => {
    if (!selectedSave) return null;
    return {
      schemaVersion: selectedSave.saveSchemaVersion,
      data: selectedSave.state,
      checksum: selectedSave.checksum,
      ...(selectedSave.seed !== null ? { seed: selectedSave.seed } : {}),
    };
  }, [selectedSave]);
  const runtimeSessionKey = platform.ownerEpoch === null
    ? null
    : `${platform.ownerEpoch}:${manifest.id}:${slotId}`;
  const hasOpenGameConflict = platform.conflicts.some((conflict) => (
    conflict.gameId === manifest.id && conflict.status === "open"
  ));
  const saveSessionRef = useRef<{
    key: string;
    localRevision: number;
    checksum: string | null;
  } | null>(null);
  if (runtimeSessionKey === null || hasOpenGameConflict) {
    saveSessionRef.current = null;
  } else if (saveSessionRef.current?.key !== runtimeSessionKey) {
    saveSessionRef.current = {
      key: runtimeSessionKey,
      localRevision: selectedSave?.localRevision ?? 0,
      checksum: selectedSave?.checksum ?? null,
    };
  }

  useEffect(() => {
    if (!platform.operationError) {
      lastErrorRef.current = null;
      return;
    }
    if (platform.operationError === lastErrorRef.current) return;
    lastErrorRef.current = platform.operationError;
    toast(`VECTOR operation failed: ${platform.operationError}`, "error", "VECTOR");
  }, [platform.operationError, toast]);

  const openConflicts = (slotId: string) => {
    const conflict = platform.conflicts
      .filter((candidate) => (
        candidate.status === "open"
        && candidate.gameId === manifest.id
        && candidate.slotId === slotId
      ))
      .sort((left, right) => (
        compareVectorText(left.createdAt, right.createdAt)
        || compareVectorText(left.id, right.id)
      ))[0];
    if (!conflict) {
      toast("The conflict is no longer open. VECTOR refreshed the local view.", "info", "VECTOR");
      void platform.refresh();
      return;
    }
    setConflictError(null);
    setSelectedConflictId(conflict.id);
  };

  const resolveSelectedConflict = async (
    resolution: Parameters<typeof platform.resolveConflict>[1],
    targetSlotId?: string,
  ) => {
    if (!selectedConflict || conflictBusy) return;
    setConflictBusy(true);
    setConflictError(null);
    try {
      await platform.resolveConflict(selectedConflict.id, resolution, targetSlotId);
      setSelectedConflictId(null);
      toast("VECTOR conflict resolved from your explicit branch choice.", "success", "VECTOR");
    } catch (error) {
      setConflictError(
        error instanceof Error && /^VECTOR_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "VECTOR_CONFLICT_RESOLUTION_FAILED",
      );
    } finally {
      setConflictBusy(false);
    }
  };

  const retrySelectedMigration = async () => {
    if (
      !selectedConflict
      || conflictBusy
      || platform.ownerEpoch === null
      || manifest.status !== "available"
    ) {
      return;
    }
    setConflictBusy(true);
    setConflictError(null);
    try {
      const { loadVectorGame } = await import("@/lib/vector/loaders");
      const gameModule = await loadVectorGame(manifest.loaderKey);
      await platform.retrySaveMigration({
        conflictId: selectedConflict.id,
        ownerEpoch: platform.ownerEpoch,
        gameVersion: manifest.version,
        targetSaveSchemaVersion: manifest.saveSchemaVersion,
        migrators: gameModule.saveMigrators ?? [],
      });
      setSelectedConflictId(null);
      toast("The preserved save migrated and remains pending synchronization.", "success", "VECTOR");
    } catch (error) {
      setConflictError(
        error instanceof Error && /^VECTOR_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "VECTOR_MIGRATION_RETRY_FAILED",
      );
    } finally {
      setConflictBusy(false);
    }
  };

  return (
    <>
      {platform.localDataState.status !== "ready" ? (
        <div className={styles.gameDataState} data-testid="vector-game-data-state">
          <StatusCallout
            kind={platform.localDataState.status === "loading" ? "loading" : "error"}
            title="Owner-scoped game records are not ready."
          >
            {platform.localDataState.message}
          </StatusCallout>
        </div>
      ) : null}
      <VectorGameShell
        manifest={manifest}
        summary={summary}
        settings={platform.settings}
        actions={{
          onOpenConflicts(gameId, slotId) {
            if (gameId === manifest.id) openConflicts(slotId);
          },
        }}
        onSettingsChange={
          platform.localDataState.status === "ready"
            ? platform.updateSettings
            : undefined
        }
        runtimeReady={
          platform.localDataState.status === "ready"
          && platform.ownerEpoch !== null
        }
        initialSave={initialSave}
        registerOwnerTransitionBarrier={platform.registerOwnerTransitionBarrier}
        onSaveMigrationFailure={async (code) => {
          if (platform.ownerEpoch === null) {
            throw new Error("VECTOR_OWNER_CHANGED");
          }
          const session = saveSessionRef.current;
          if (
            !session
            || session.key !== runtimeSessionKey
            || session.localRevision <= 0
            || !session.checksum
          ) {
            throw new Error("VECTOR_SAVE_SESSION_STALE");
          }
          await platform.quarantineSaveMigrationFailure({
            gameId: manifest.id,
            slotId,
            ownerEpoch: platform.ownerEpoch,
            expectedAncestor: {
              localRevision: session.localRevision,
              checksum: session.checksum,
            },
            code,
          });
        }}
        onRecordScore={async (input) => {
          if (platform.ownerEpoch === null) return;
          try {
            await platform.recordScore(manifest.id, input);
          } catch {
            // Failure is already surfaced via platform.operationError and a
            // toast (see the effect above); a score that fails to record
            // locally must not crash the game's own completion screen.
          }
        }}
        onGetBestScore={(input) => platform.getBestScore(manifest.id, input.mode, input.challengeId)}
        onSave={async (save, reason) => {
          if (platform.ownerEpoch === null) {
            throw new Error("VECTOR_OWNER_CHANGED");
          }
          const session = saveSessionRef.current;
          if (!session || session.key !== runtimeSessionKey) {
            throw new Error("VECTOR_SAVE_SESSION_STALE");
          }
          const saved = await platform.saveGame({
            gameId: manifest.id,
            slotId,
            gameVersion: manifest.version,
            saveSchemaVersion: manifest.saveSchemaVersion,
            ownerEpoch: platform.ownerEpoch,
            expectedAncestor: session.localRevision > 0 && session.checksum
              ? {
                  localRevision: session.localRevision,
                  checksum: session.checksum,
                }
              : null,
            save,
            reason,
          });
          if (saveSessionRef.current?.key === session.key) {
            saveSessionRef.current = {
              key: session.key,
              localRevision: saved.localRevision,
              checksum: saved.checksum,
            };
          }
        }}
      />
      <VectorAdoptionModal
        offer={platform.adoptionOffer}
        motion={platform.settings.resolvedMotion}
        onAccept={async () => {
          try {
            await platform.adoptAnonymousData();
            toast("Anonymous VECTOR records were merged into this account.", "success", "VECTOR");
          } catch {
            toast("Anonymous records remain separate because the merge failed.", "error", "VECTOR");
          }
        }}
        onDecline={platform.declineAnonymousData}
      />
      <VectorConflictModal
        conflict={selectedConflict}
        busy={conflictBusy}
        error={conflictError}
        motion={platform.settings.resolvedMotion}
        migrationRetryAvailable={manifest.status === "available"}
        onClose={() => {
          setConflictError(null);
          setSelectedConflictId(null);
        }}
        onResolve={resolveSelectedConflict}
        onRetryMigration={retrySelectedMigration}
      />
    </>
  );
}
