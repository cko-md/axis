"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { VectorAdoptionModal } from "@/components/vector/VectorAdoptionModal";
import { VectorConflictModal } from "@/components/vector/VectorConflictModal";
import { VectorLobbyModule } from "@/components/vector/VectorLobbyModule";
import { useVectorOffline } from "@/hooks/useVectorOffline";
import { useVectorPlatform } from "@/hooks/useVectorPlatform";
import { compareVectorText } from "@/lib/vector/checksum";
import { getVectorGame, isVectorGameSlug } from "@/lib/vector/registry";
import { resolveVectorMotionPreference } from "@/lib/vector/runtime";
import type { VectorLibraryActions } from "@/lib/vector/types";

export function VectorLobbyPlatform() {
  const { toast } = useToast();
  const platform = useVectorPlatform();
  const offline = useVectorOffline();
  const lastErrorRef = useRef<string | null>(null);
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const selectedConflict = platform.conflicts.find(
    (conflict) => conflict.id === selectedConflictId && conflict.status === "open",
  ) ?? null;
  const selectedConflictGame = selectedConflict
    ? getVectorGame(selectedConflict.gameId)
    : undefined;
  const modalMotion = resolveVectorMotionPreference(
    platform.settings.motionPreference,
    systemReducedMotion,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setSystemReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!platform.operationError) {
      lastErrorRef.current = null;
      return;
    }
    if (platform.operationError === lastErrorRef.current) return;
    lastErrorRef.current = platform.operationError;
    toast(
      `VECTOR operation failed: ${platform.operationError}`,
      "error",
      "VECTOR",
    );
  }, [platform.operationError, toast]);

  const actions: Partial<VectorLibraryActions> = {
    onSync(gameId) {
      void platform.syncGame(gameId).then((outcome) => {
        if (outcome.status === "synced") {
          toast("Pending VECTOR records synchronized.", "success", "VECTOR");
        } else if (outcome.status === "partial") {
          toast(
            "Some VECTOR records synchronized; rejected records remain visible and pending.",
            "error",
            "VECTOR",
          );
        } else if (outcome.status === "error") {
          toast(`Synchronization remains pending: ${outcome.code}`, "error", "VECTOR");
        }
      });
    },
    onRequestPersistentStorage() {
      void offline.persist().then((granted) => {
        if (granted === true) {
          toast("Persistent browser storage is active.", "success", "VECTOR");
        } else if (granted === false) {
          toast("The browser kept best-effort storage. Existing records were not changed.", "info", "VECTOR");
        } else {
          toast("This browser does not expose a persistent-storage request.", "info", "VECTOR");
        }
      }).catch(() => undefined);
    },
    async onClearOwnerData() {
      await platform.clearOwnerData();
      toast("This owner namespace was cleared from local VECTOR storage.", "success", "VECTOR");
    },
    onInstall(gameId) {
      void offline.install(gameId).then(() => {
        toast("Verified offline package installed.", "success", "VECTOR");
      }).catch((error) => {
        toast(
          error instanceof Error ? error.message : "The offline package could not be installed.",
          "error",
          "VECTOR",
        );
      });
    },
    onRemoveInstall(gameId) {
      void offline.remove(gameId).then(() => {
        toast("Offline package removed from this device.", "success", "VECTOR");
      }).catch((error) => {
        toast(
          error instanceof Error ? error.message : "The offline package could not be removed.",
          "error",
          "VECTOR",
        );
      });
    },
    onOpenConflicts(gameId, slotId) {
      const conflict = platform.conflicts
        .filter((candidate) => (
          candidate.status === "open"
          && candidate.gameId === gameId
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
    },
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
      || !selectedConflictGame
      || selectedConflictGame.status !== "available"
      || platform.ownerEpoch === null
      || conflictBusy
    ) {
      return;
    }
    setConflictBusy(true);
    setConflictError(null);
    try {
      const { loadVectorGame } = await import("@/lib/vector/loaders");
      const gameModule = await loadVectorGame(selectedConflictGame.loaderKey);
      await platform.retrySaveMigration({
        conflictId: selectedConflict.id,
        ownerEpoch: platform.ownerEpoch,
        gameVersion: selectedConflictGame.version,
        targetSaveSchemaVersion: selectedConflictGame.saveSchemaVersion,
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
      <VectorLobbyModule
        summaries={platform.summaries}
        actions={actions}
        settings={platform.settings}
        onSettingsChange={
          platform.localDataState.status === "ready"
            ? platform.updateSettings
            : undefined
        }
        localDataState={platform.localDataState}
        offlineStorage={{
          loading: offline.loading,
          supported: offline.supported,
          statusAvailable: offline.statusAvailable,
          installs: offline.installed.flatMap((installed) => {
            if (!isVectorGameSlug(installed.gameId)) return [];
            const game = getVectorGame(installed.gameId);
            return [{
              gameId: installed.gameId,
              state: "installed" as const,
              estimatedBytes:
                offline.deployments[installed.gameId]?.estimatedBytes
                ?? game?.offline.estimatedBytes
                ?? null,
              installedBytes: installed.installedBytes,
              buildId: installed.buildId,
            }];
          }),
          installableGameIds: Object.keys(offline.deployments).filter(isVectorGameSlug),
          busy: offline.busy,
          usage: offline.usage,
          quota: offline.quota,
          persisted: offline.persisted,
          error: offline.error,
        }}
        ownerScope={platform.ownerScope ?? undefined}
      />
      <VectorAdoptionModal
        offer={platform.adoptionOffer}
        onAccept={async () => {
          try {
            await platform.adoptAnonymousData();
            toast("Anonymous VECTOR records were merged into this account.", "success", "VECTOR");
          } catch {
            toast("Anonymous records remain separate because the merge failed.", "error", "VECTOR");
          }
        }}
        onDecline={platform.declineAnonymousData}
        motion={modalMotion}
      />
      <VectorConflictModal
        conflict={selectedConflict}
        busy={conflictBusy}
        error={conflictError}
        motion={modalMotion}
        migrationRetryAvailable={selectedConflictGame?.status === "available"}
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
