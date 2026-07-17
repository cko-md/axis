"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  estimateVectorStorage,
  getVectorOfflineStatus,
  installVectorOffline,
  removeVectorOffline,
  requestPersistentVectorStorage,
  VectorOfflineWorkerError,
  type VectorInstalledGame,
} from "@/lib/vector/offline";
import {
  indexVectorOfflineDeployments,
  loadVectorOfflineBuildMap,
  type VectorOfflineDeployment,
} from "@/lib/vector/offline-deployment";
import type { VectorGameSlug } from "@/lib/vector/types";

export type VectorOfflineBusy = {
  gameId: VectorGameSlug;
  operation: "install" | "remove";
};

export type VectorOfflineView = {
  loading: boolean;
  supported: boolean;
  statusAvailable: boolean;
  installed: VectorInstalledGame[];
  deployments: Partial<Record<VectorGameSlug, VectorOfflineDeployment>>;
  busy: VectorOfflineBusy | null;
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
  error: string | null;
};

const INITIAL: VectorOfflineView = {
  loading: true,
  supported: false,
  statusAvailable: false,
  installed: [],
  deployments: {},
  busy: null,
  usage: null,
  quota: null,
  persisted: null,
  error: null,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function captureOfflineError(operation: string, error: unknown) {
  Sentry.captureException(
    error instanceof Error ? error : new Error(`VECTOR offline ${operation} failed`),
    {
      tags: {
        feature: "vector-offline",
        operation,
      },
    },
  );
}

export function useVectorOffline() {
  const [view, setView] = useState<VectorOfflineView>(INITIAL);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const busyRef = useRef<VectorOfflineBusy | null>(null);

  const isCurrent = useCallback((requestId: number) => (
    mountedRef.current && requestRef.current === requestId
  ), []);

  const beginRequest = useCallback((markLoading = true) => {
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setView((current) => ({
        ...current,
        loading: markLoading ? true : current.loading,
        error: null,
      }));
    }
    return requestId;
  }, []);

  const refresh = useCallback(async () => {
    const requestId = beginRequest();
    const [statusResult, storageResult, deploymentResult] = await Promise.allSettled([
      getVectorOfflineStatus(),
      estimateVectorStorage(),
      loadVectorOfflineBuildMap(),
    ]);

    if (statusResult.status === "rejected") {
      captureOfflineError("status", statusResult.reason);
    }
    if (storageResult.status === "rejected") {
      captureOfflineError("storage", storageResult.reason);
    }
    if (deploymentResult.status === "rejected") {
      captureOfflineError("deployment-map", deploymentResult.reason);
    }
    if (!isCurrent(requestId)) return;

    const status = statusResult.status === "fulfilled"
      ? statusResult.value
      : { supported: false, installed: [] };
    const storage = storageResult.status === "fulfilled"
      ? storageResult.value
      : { usage: null, quota: null, persisted: null };
    const deployments = deploymentResult.status === "fulfilled"
      ? indexVectorOfflineDeployments(deploymentResult.value)
      : {};
    const error = statusResult.status === "rejected"
      ? errorMessage(statusResult.reason, "Offline game status is unavailable.")
      : deploymentResult.status === "rejected"
        ? errorMessage(deploymentResult.reason, "Offline deployment details are unavailable.")
        : storageResult.status === "rejected"
          ? errorMessage(storageResult.reason, "Browser storage details are unavailable.")
          : null;

    setView((current) => ({
      loading: false,
      supported: status.supported,
      statusAvailable: statusResult.status === "fulfilled",
      installed: status.installed,
      deployments,
      busy: current.busy,
      usage: storage.usage,
      quota: storage.quota,
      persisted: storage.persisted,
      error,
    }));
  }, [beginRequest, isCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      busyRef.current = null;
    };
  }, [refresh]);

  const install = useCallback(async (gameId: VectorGameSlug) => {
    const deployment = view.deployments[gameId];
    if (!deployment) {
      throw new VectorOfflineWorkerError(
        "VECTOR_OFFLINE_PACKAGE_UNAVAILABLE",
        "No verified offline package exists for this deployed game build.",
      );
    }
    if (busyRef.current) {
      throw new VectorOfflineWorkerError(
        "VECTOR_OFFLINE_BUSY",
        "Another offline package action is still running.",
      );
    }
    beginRequest(false);
    const busy: VectorOfflineBusy = { gameId, operation: "install" };
    busyRef.current = busy;
    if (mountedRef.current) setView((current) => ({ ...current, busy, error: null }));
    try {
      await installVectorOffline(deployment);
      if (mountedRef.current) await refresh();
    } catch (error) {
      captureOfflineError("install", error);
      if (mountedRef.current) {
        setView((current) => ({
          ...current,
          loading: false,
          busy: null,
          error: errorMessage(error, "The offline game could not be installed."),
        }));
      }
      throw error;
    } finally {
      busyRef.current = null;
      if (mountedRef.current) setView((current) => ({ ...current, busy: null }));
    }
  }, [beginRequest, refresh, view.deployments]);

  const remove = useCallback(async (gameId: VectorGameSlug) => {
    if (busyRef.current) {
      throw new VectorOfflineWorkerError(
        "VECTOR_OFFLINE_BUSY",
        "Another offline package action is still running.",
      );
    }
    beginRequest(false);
    const busy: VectorOfflineBusy = { gameId, operation: "remove" };
    busyRef.current = busy;
    if (mountedRef.current) setView((current) => ({ ...current, busy, error: null }));
    try {
      await removeVectorOffline(gameId);
      if (mountedRef.current) await refresh();
    } catch (error) {
      captureOfflineError("remove", error);
      if (mountedRef.current) {
        setView((current) => ({
          ...current,
          loading: false,
          busy: null,
          error: errorMessage(error, "The offline game could not be removed."),
        }));
      }
      throw error;
    } finally {
      busyRef.current = null;
      if (mountedRef.current) setView((current) => ({ ...current, busy: null }));
    }
  }, [beginRequest, refresh]);

  const persist = useCallback(async () => {
    const requestId = beginRequest();
    try {
      const granted = await requestPersistentVectorStorage();
      if (isCurrent(requestId)) await refresh();
      return granted;
    } catch (error) {
      captureOfflineError("persist", error);
      if (isCurrent(requestId)) {
        setView((current) => ({
          ...current,
          loading: false,
          error: errorMessage(error, "Persistent browser storage could not be requested."),
        }));
      }
      throw error;
    }
  }, [beginRequest, isCurrent, refresh]);

  return {
    ...view,
    refresh,
    install,
    remove,
    persist,
  };
}
