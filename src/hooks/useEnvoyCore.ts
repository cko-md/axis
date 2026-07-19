"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ENVOY_ID,
  envoyIdFromLegacyCompanion,
  type EnvoyId,
} from "@/lib/envoys/registry";
import {
  projectEnvoyActiveWork,
  type EnvoyActiveWork,
  type EnvoySectionInput,
  type RawApproval,
  type RawRun,
  type RawTask,
} from "@/lib/envoys/activeWork";

/**
 * Wave 15.4 Envoy core hook.
 *
 * - Active work: bounded polling (no realtime dependency — VE-RISK-010's
 *   "Realtime accelerates, bounded polling verifies" simplification) over the
 *   three existing owner-scoped APIs. Each section degrades independently;
 *   a failed fetch is surfaced as degraded, never as empty.
 * - Selection: the active Envoy id persists through the EXISTING vector
 *   profile-settings contract (owner-scoped, clock-merged, offline-safe,
 *   cross-device via the existing sync path) — no new schema, no new API.
 *   The vector platform already stores platform-wide settings under its
 *   settings channel; `activeEnvoyId` is one more key in that envelope.
 */

const POLL_INTERVAL_MS = 30_000;
const ACTIVE_ENVOY_SETTING_KEY = "activeEnvoyId";
// The vector settings channel: platform-wide profile settings ride the first
// catalog slug's event channel by existing convention (see SETTINGS_CHANNEL
// in useVectorPlatform).
const SETTINGS_CHANNEL = "second-sense" as const;

export type EnvoyWorkView =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "ready"; work: EnvoyActiveWork };

export type EnvoySelectionView = {
  activeEnvoyId: EnvoyId;
  /** "local-only" until the repository write path confirms persistence. */
  persistence: "loading" | "persisted" | "local-only" | "error";
};

async function fetchSection<Raw>(
  url: string,
  extract: (body: unknown) => Raw[] | undefined,
  signal: AbortSignal,
): Promise<EnvoySectionInput<Raw> | "unauthorized"> {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (response.status === 401) return "unauthorized";
    if (!response.ok) return { ok: false, code: `HTTP_${response.status}` };
    const rows = extract(await response.json());
    if (!Array.isArray(rows)) return { ok: false, code: "MALFORMED_RESPONSE" };
    return { ok: true, rows };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, code: "NETWORK_UNAVAILABLE" };
  }
}

export function useEnvoyCore() {
  const [workView, setWorkView] = useState<EnvoyWorkView>({ status: "loading" });
  const [selection, setSelection] = useState<EnvoySelectionView>({
    activeEnvoyId: DEFAULT_ENVOY_ID,
    persistence: "loading",
  });
  const mountedRef = useRef(true);
  const repositoryRef = useRef<{
    write: (id: EnvoyId) => Promise<void>;
  } | null>(null);

  const refreshWork = useCallback(async (signal: AbortSignal) => {
    const [tasks, approvals, runs] = await Promise.all([
      fetchSection<RawTask>(
        "/api/agent-tasks",
        (body) => (body as { tasks?: RawTask[] })?.tasks,
        signal,
      ),
      fetchSection<RawApproval>(
        "/api/approvals",
        (body) => (body as { approvals?: RawApproval[] })?.approvals,
        signal,
      ),
      fetchSection<RawRun>(
        "/api/routines/runs",
        (body) => (body as { runs?: RawRun[] })?.runs,
        signal,
      ),
    ]);
    if (!mountedRef.current) return;
    if (tasks === "unauthorized" || approvals === "unauthorized" || runs === "unauthorized") {
      setWorkView({ status: "signed-out" });
      return;
    }
    setWorkView({
      status: "ready",
      work: projectEnvoyActiveWork({ tasks, approvals, runs }),
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refreshWork(controller.signal).catch(() => undefined);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return; // low-rate: no hidden-tab polling
      void refreshWork(controller.signal).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshWork]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Lazy import keeps Dexie/vector persistence out of this chunk until
        // the surface actually mounts.
        const persistence = await import("@/lib/vector/persistence");
        const { repository, deviceId, ownerKey } = await persistence.openVectorRepository();
        if (cancelled) return;
        const profile = await repository.loadProfile(ownerKey);
        if (cancelled) return;
        const stored = profile?.settings?.[ACTIVE_ENVOY_SETTING_KEY];
        setSelection({
          activeEnvoyId: envoyIdFromLegacyCompanion(stored),
          persistence: "persisted",
        });
        repositoryRef.current = {
          async write(id: EnvoyId) {
            await repository.updateProfileSettings({
              ownerKey,
              gameId: SETTINGS_CHANNEL,
              deviceId,
              values: { [ACTIVE_ENVOY_SETTING_KEY]: id },
              clocks: {
                [ACTIVE_ENVOY_SETTING_KEY]: { at: new Date().toISOString(), deviceId },
              },
            });
          },
        };
      } catch {
        if (cancelled) return;
        // IndexedDB unavailable/quota/etc. — selection still works for this
        // session, honestly labeled local-only.
        setSelection((current) => ({ ...current, persistence: "local-only" }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectEnvoy = useCallback((id: EnvoyId) => {
    setSelection((current) => ({ ...current, activeEnvoyId: id }));
    const writer = repositoryRef.current;
    if (!writer) return;
    void writer.write(id).catch(() => {
      if (mountedRef.current) {
        setSelection((current) => ({ ...current, persistence: "error" }));
      }
    });
  }, []);

  return { workView, selection, selectEnvoy };
}
