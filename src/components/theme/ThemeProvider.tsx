"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import type { ThemeMode } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  applyInterfaceSettings,
  DEFAULT_INTERFACE_SETTINGS,
  type InterfaceSettings,
} from "@/lib/theme/interface-settings";
import { getBrowserTimeZone } from "@/lib/dates";
import {
  canUseInterfacePreferenceCache,
  InterfacePreferenceWriteQueue,
  INTERFACE_PREFERENCES_VERSION_UNSUPPORTED,
  hydrateInterfacePreferenceSnapshot,
  interfacePreferenceSignature,
  isThemeMode,
  mergeInterfacePreferenceEnvelope,
  normalizeInterfaceSettings,
  parseInterfacePreferences,
  shouldClaimInterfacePreferenceCache,
  shouldPersistInterfacePreferences,
  shouldResetInterfacePreferenceCache,
  updateInterfaceSettingsPatch,
  type InterfaceSettingsPatch,
  type ParsedInterfacePreferences,
} from "@/lib/theme/interface-preferences";

export type InterfacePersistenceState = "loading" | "local" | "syncing" | "synced" | "error" | "incompatible";
type RemoteReadState = "checking" | "local" | "succeeded" | "failed";
type SyncFailureOperation = "load" | "save" | null;

type ThemeContextValue = {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  interfaceSettings: InterfaceSettings;
  setInterfaceSettings: (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => void;
  interfacePersistence: InterfacePersistenceState;
  retryInterfaceSync: () => void;
  openInterfaceStudio: () => void;
  closeInterfaceStudio: () => void;
  interfaceStudioOpen: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_KEY = "axis-theme";
const SETTINGS_KEY = "axis-interface-settings";
const CACHE_OWNER_KEY = "axis-interface-owner";
const ACCOUNT_CHANGED_ERROR = "INTERFACE_PREFERENCE_ACCOUNT_CHANGED";
const WRITE_CONFLICT_ERROR = "INTERFACE_PREFERENCE_WRITE_CONFLICT";

function readStorage(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Safari popup/private contexts can expose a null or throwing localStorage.
  }
}

function removeStorage(key: string) {
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Safari popup/private contexts can expose a null or throwing localStorage.
  }
}

function parseStoredSettings(raw: string | null): InterfaceSettings | null {
  if (!raw) return null;
  try {
    return normalizeInterfaceSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

function capturePreferenceError(operation: "load" | "save", error: unknown) {
  Sentry.captureException(error instanceof Error ? error : new Error(`Interface preference ${operation} failed`), {
    tags: {
      feature: "interface-studio",
      operation,
      storage: "user_preferences",
    },
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [theme, setThemeState] = useState<ThemeMode>("dark");
  const [interfaceSettings, setInterfaceSettingsState] = useState<InterfaceSettings>(DEFAULT_INTERFACE_SETTINGS);
  const [interfacePersistence, setInterfacePersistence] = useState<InterfacePersistenceState>("loading");
  const [remoteReadState, setRemoteReadState] = useState<RemoteReadState>("checking");
  const [syncFailureOperation, setSyncFailureOperation] = useState<SyncFailureOperation>(null);
  const [loadRetryToken, setLoadRetryToken] = useState(0);
  const [saveRetryToken, setSaveRetryToken] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [interfaceStudioOpen, setInterfaceStudioOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const themeRef = useRef<ThemeMode>("dark");
  const interfaceSettingsRef = useRef<InterfaceSettings>(DEFAULT_INTERFACE_SETTINGS);
  const remoteEnvelopeRef = useRef<ParsedInterfacePreferences | null>(null);
  const persistedSignatureRef = useRef<string | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);
  const observedAuthUserIdRef = useRef<string | null | undefined>(undefined);
  const pendingThemeRef = useRef<ThemeMode | undefined>(undefined);
  const pendingSettingsRef = useRef<InterfaceSettingsPatch>({});
  const editRevisionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const writeQueueRef = useRef(new InterfacePreferenceWriteQueue());

  const resetRemoteAccount = useCallback((nextUserId: string | null) => {
    loadRequestRef.current += 1;
    writeQueueRef.current.invalidate();
    removeStorage(THEME_KEY);
    removeStorage(SETTINGS_KEY);
    removeStorage(CACHE_OWNER_KEY);
    loadedUserIdRef.current = null;
    remoteEnvelopeRef.current = null;
    persistedSignatureRef.current = null;
    pendingThemeRef.current = undefined;
    pendingSettingsRef.current = {};
    editRevisionRef.current += 1;
    themeRef.current = "dark";
    interfaceSettingsRef.current = DEFAULT_INTERFACE_SETTINGS;
    setThemeState("dark");
    setInterfaceSettingsState(DEFAULT_INTERFACE_SETTINGS);
    setCurrentUserId(nextUserId);
    setSyncFailureOperation(null);
    setRemoteReadState(nextUserId ? "checking" : "local");
    setInterfacePersistence(nextUserId ? "loading" : "local");
    setLoadRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const stored = readStorage(THEME_KEY) as ThemeMode | null;
    if (isThemeMode(stored)) {
      themeRef.current = stored;
      setThemeState(stored);
    }
    const storedSettings = parseStoredSettings(readStorage(SETTINGS_KEY));
    if (storedSettings) {
      interfaceSettingsRef.current = storedSettings;
      setInterfaceSettingsState(storedSettings);
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id ?? null;
      const previousUserId = observedAuthUserIdRef.current;
      observedAuthUserIdRef.current = nextUserId;
      const cachedOwner = readStorage(CACHE_OWNER_KEY);

      if (shouldResetInterfacePreferenceCache({
        cachedOwner,
        previousUserId,
        nextUserId,
      })) {
        resetRemoteAccount(nextUserId);
      } else {
        if (
          nextUserId &&
          shouldClaimInterfacePreferenceCache(cachedOwner, nextUserId)
        ) {
          writeStorage(CACHE_OWNER_KEY, nextUserId);
        }
        setCurrentUserId(nextUserId);
        if (nextUserId && previousUserId !== nextUserId) {
          setInterfacePersistence("loading");
          setRemoteReadState("checking");
          setSyncFailureOperation(null);
          setLoadRetryToken((token) => token + 1);
        }
      }
    });

    return () => subscription.unsubscribe();
  }, [resetRemoteAccount, supabase]);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    const requestId = ++loadRequestRef.current;
    const isStaleRequest = () => cancelled || loadRequestRef.current !== requestId;
    const loadRemotePreferences = async () => {
      setInterfacePersistence("loading");
      setRemoteReadState("checking");
      setSyncFailureOperation(null);

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (isStaleRequest()) return;
      if (authError) {
        capturePreferenceError("load", authError);
        setInterfacePersistence("error");
        setRemoteReadState("failed");
        setSyncFailureOperation("load");
        return;
      }
      const nextUserId = user?.id ?? null;
      const cachedOwner = readStorage(CACHE_OWNER_KEY);
      if (
        observedAuthUserIdRef.current !== undefined &&
        observedAuthUserIdRef.current !== nextUserId
      ) {
        return;
      }
      if (shouldResetInterfacePreferenceCache({
        cachedOwner,
        previousUserId: observedAuthUserIdRef.current,
        nextUserId,
      })) {
        resetRemoteAccount(nextUserId);
        return;
      }
      if (!user) {
        observedAuthUserIdRef.current = null;
        setCurrentUserId(null);
        loadedUserIdRef.current = null;
        setInterfacePersistence("local");
        setRemoteReadState("local");
        persistedSignatureRef.current = null;
        remoteEnvelopeRef.current = null;
        return;
      }
      if (loadedUserIdRef.current && loadedUserIdRef.current !== user.id) {
        resetRemoteAccount(user.id);
        return;
      }
      observedAuthUserIdRef.current = user.id;
      setCurrentUserId(user.id);
      if (shouldClaimInterfacePreferenceCache(cachedOwner, user.id)) {
        // Claim anonymous local edits before the remote read. If that read
        // fails, the cache remains bound to this account and cannot later
        // hydrate another user.
        writeStorage(CACHE_OWNER_KEY, user.id);
      }

      const { data, error } = await supabase
        .from("user_preferences")
        .select("interface_settings")
        .eq("user_id", user.id)
        .maybeSingle();
      if (
        isStaleRequest() ||
        (observedAuthUserIdRef.current !== undefined &&
          observedAuthUserIdRef.current !== user.id)
      ) {
        return;
      }
      if (error) {
        capturePreferenceError("load", error);
        setInterfacePersistence("error");
        setRemoteReadState("failed");
        setSyncFailureOperation("load");
        return;
      }

      const remote = parseInterfacePreferences(data?.interface_settings);
      const hydrated = hydrateInterfacePreferenceSnapshot({
        remote,
        cached: {
          theme: themeRef.current,
          settings: interfaceSettingsRef.current,
        },
        cacheOwnedByUser: canUseInterfacePreferenceCache(cachedOwner, user.id),
        pendingTheme: pendingThemeRef.current,
        pendingSettings: pendingSettingsRef.current,
      });

      remoteEnvelopeRef.current = remote;
      loadedUserIdRef.current = user.id;
      persistedSignatureRef.current = remote?.theme && remote?.settings && !remote.requiresRewrite
        ? interfacePreferenceSignature({
          theme: remote.theme,
          settings: remote.settings,
          timeZone: remote.timeZone,
        })
        : null;

      themeRef.current = hydrated.theme;
      interfaceSettingsRef.current = hydrated.settings;
      setThemeState(hydrated.theme);
      setInterfaceSettingsState(hydrated.settings);
      writeStorage(CACHE_OWNER_KEY, user.id);

      if (remote && !remote.writeCompatible) {
        setInterfacePersistence("incompatible");
        setRemoteReadState("failed");
        setSyncFailureOperation(null);
        return;
      }

      setInterfacePersistence("synced");
      setRemoteReadState("succeeded");
      setSyncFailureOperation(null);
    };

    loadRemotePreferences().catch((error) => {
      if (!isStaleRequest()) {
        capturePreferenceError("load", error);
        setInterfacePersistence("error");
        setRemoteReadState("failed");
        setSyncFailureOperation("load");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadRetryToken, mounted, resetRemoteAccount, supabase]);

  useEffect(() => {
    if (!mounted) return;
    const html = document.documentElement;
    html.classList.remove("dim", "light", "slate");
    if (theme !== "dark") html.classList.add(theme);
    writeStorage(THEME_KEY, theme);
  }, [theme, mounted]);

  useEffect(() => {
    if (!mounted) return;
    // theme stays a dependency: surface-tone color-mix must re-derive from the new theme's base tokens
    applyInterfaceSettings(interfaceSettings);
    writeStorage(SETTINGS_KEY, JSON.stringify(interfaceSettings));
  }, [interfaceSettings, theme, mounted]);

  useEffect(() => {
    const loadedUserId = loadedUserIdRef.current;
    const snapshot = {
      theme,
      settings: interfaceSettings,
      timeZone: remoteEnvelopeRef.current?.timeZone ?? getBrowserTimeZone(),
    };
    const currentSignature = interfacePreferenceSignature(snapshot);
    if (!shouldPersistInterfacePreferences({
      mounted,
      remoteReadSucceeded: remoteReadState === "succeeded",
      loadedUserId,
      currentUserId,
      currentSignature,
      persistedSignature: persistedSignatureRef.current,
    })) {
      return;
    }
    const editRevision = editRevisionRef.current;
    const pendingTheme = pendingThemeRef.current;
    const pendingSettings: InterfaceSettingsPatch = {
      ...pendingSettingsRef.current,
      ...(pendingSettingsRef.current.notifFeatures
        ? { notifFeatures: { ...pendingSettingsRef.current.notifFeatures } }
        : {}),
    };

    const timer = window.setTimeout(() => {
      if (!loadedUserId) return;

      let revision = 0;
      let writtenSignature = currentSignature;
      const queued = writeQueueRef.current.enqueue(async () => {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!user || user.id !== loadedUserId || loadedUserIdRef.current !== loadedUserId) {
          resetRemoteAccount(user?.id ?? null);
          throw new Error(ACCOUNT_CHANGED_ERROR);
        }

        if (writeQueueRef.current.isLatest(revision)) {
          setInterfacePersistence("syncing");
        }

        const { data: latestData, error: latestReadError } = await supabase
          .from("user_preferences")
          .select("interface_settings, updated_at")
          .eq("user_id", user.id)
          .maybeSingle();
        if (latestReadError) throw latestReadError;
        if (loadedUserIdRef.current !== loadedUserId) {
          throw new Error(ACCOUNT_CHANGED_ERROR);
        }

        const latestEnvelope = parseInterfacePreferences(latestData?.interface_settings);
        if (latestEnvelope && !latestEnvelope.writeCompatible) {
          remoteEnvelopeRef.current = latestEnvelope;
          throw new Error(INTERFACE_PREFERENCES_VERSION_UNSUPPORTED);
        }

        const snapshotToWrite = {
          ...hydrateInterfacePreferenceSnapshot({
            remote: latestEnvelope,
            cached: snapshot,
            cacheOwnedByUser: true,
            pendingTheme,
            pendingSettings,
          }),
          timeZone: latestEnvelope?.timeZone ?? snapshot.timeZone,
        };
        const envelope = mergeInterfacePreferenceEnvelope(latestEnvelope, snapshotToWrite);
        const updatedAt = new Date().toISOString();
        if (latestData) {
          const { data: updated, error: updateError } = await supabase
            .from("user_preferences")
            .update({
              interface_settings: envelope,
              updated_at: updatedAt,
            })
            .eq("user_id", user.id)
            .eq("updated_at", latestData.updated_at)
            .select("updated_at")
            .maybeSingle();
          if (updateError) throw updateError;
          if (!updated) {
            const { data: currentRow, error: conflictReadError } = await supabase
              .from("user_preferences")
              .select("updated_at")
              .eq("user_id", user.id)
              .maybeSingle();
            if (conflictReadError) throw conflictReadError;
            if (!currentRow || currentRow.updated_at !== latestData.updated_at) {
              throw new Error(WRITE_CONFLICT_ERROR);
            }
            throw new Error("INTERFACE_PREFERENCE_CAS_FAILED");
          }
        } else {
          const { error: insertError } = await supabase
            .from("user_preferences")
            .insert({
              user_id: user.id,
              interface_settings: envelope,
              updated_at: updatedAt,
            });
          if (insertError?.code === "23505") throw new Error(WRITE_CONFLICT_ERROR);
          if (insertError) throw insertError;
        }
        if (loadedUserIdRef.current !== loadedUserId) {
          throw new Error(ACCOUNT_CHANGED_ERROR);
        }

        const writtenEnvelope = parseInterfacePreferences(envelope);
        remoteEnvelopeRef.current = writtenEnvelope;
        writtenSignature = interfacePreferenceSignature({
          ...snapshotToWrite,
          timeZone: writtenEnvelope?.timeZone,
        });
        persistedSignatureRef.current = writtenSignature;
        if (editRevisionRef.current === editRevision) {
          themeRef.current = snapshotToWrite.theme;
          interfaceSettingsRef.current = snapshotToWrite.settings;
          setThemeState(snapshotToWrite.theme);
          setInterfaceSettingsState(snapshotToWrite.settings);
        }
        writeStorage(CACHE_OWNER_KEY, user.id);
      });
      revision = queued.revision;

      queued.done.then((result) => {
        if (
          result !== "completed" ||
          !writeQueueRef.current.isLatest(revision) ||
          loadedUserIdRef.current !== loadedUserId
        ) {
          return;
        }
        const liveSignature = interfacePreferenceSignature({
          theme: themeRef.current,
          settings: interfaceSettingsRef.current,
          timeZone: remoteEnvelopeRef.current?.timeZone ?? getBrowserTimeZone(),
        });
        if (liveSignature === writtenSignature) {
          pendingThemeRef.current = undefined;
          pendingSettingsRef.current = {};
          setInterfacePersistence("synced");
          setSyncFailureOperation(null);
        }
      }).catch((error) => {
        if (
          writeQueueRef.current.isLatest(revision) &&
          loadedUserIdRef.current === loadedUserId &&
          error instanceof Error &&
          error.message === INTERFACE_PREFERENCES_VERSION_UNSUPPORTED
        ) {
          setInterfacePersistence("incompatible");
          setRemoteReadState("failed");
          setSyncFailureOperation(null);
          return;
        }
        if (
          !writeQueueRef.current.isLatest(revision) ||
          loadedUserIdRef.current !== loadedUserId ||
          (error instanceof Error && error.message === ACCOUNT_CHANGED_ERROR)
        ) {
          return;
        }
        if (!(error instanceof Error && error.message === WRITE_CONFLICT_ERROR)) {
          capturePreferenceError("save", error);
        }
        setInterfacePersistence("error");
        setSyncFailureOperation("save");
      });
    }, 450);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    currentUserId,
    interfaceSettings,
    mounted,
    remoteReadState,
    resetRemoteAccount,
    saveRetryToken,
    supabase,
    theme,
  ]);

  const setTheme = useCallback((t: ThemeMode) => {
    if (themeRef.current !== t) {
      pendingThemeRef.current = t;
      editRevisionRef.current += 1;
    }
    themeRef.current = t;
    setThemeState(t);
  }, []);
  const setInterfaceSettings = useCallback(
    (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => {
      setInterfaceSettingsState((previous) => {
        const next = typeof s === "function" ? s(previous) : s;
        const changed = JSON.stringify(previous) !== JSON.stringify(next);
        pendingSettingsRef.current = updateInterfaceSettingsPatch(
          pendingSettingsRef.current,
          previous,
          next,
        );
        if (changed) editRevisionRef.current += 1;
        interfaceSettingsRef.current = next;
        return next;
      });
    },
    [],
  );
  const retryInterfaceSync = useCallback(() => {
    if (syncFailureOperation === "save" && remoteReadState === "succeeded") {
      setInterfacePersistence("syncing");
      setSaveRetryToken((token) => token + 1);
      return;
    }
    setInterfacePersistence("loading");
    setLoadRetryToken((token) => token + 1);
  }, [remoteReadState, syncFailureOperation]);
  const openInterfaceStudio = useCallback(() => setInterfaceStudioOpen(true), []);
  const closeInterfaceStudio = useCallback(() => setInterfaceStudioOpen(false), []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        interfaceSettings,
        setInterfaceSettings,
        interfacePersistence,
        retryInterfaceSync,
        openInterfaceStudio,
        closeInterfaceStudio,
        interfaceStudioOpen,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
