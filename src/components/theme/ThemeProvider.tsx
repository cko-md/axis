"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Sentry from "@sentry/nextjs";
import type { ThemeMode } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  applyInterfaceSettings,
  DEFAULT_INTERFACE_SETTINGS,
  type InterfaceSettings,
} from "@/lib/theme/interface-settings";
import { getBrowserTimeZone } from "@/lib/dates";
import { isProfileSubject } from "@/lib/auth/profileSubject";
import { deferFailureCommit } from "@/lib/observability/deferFailureCommit";
import {
  buildPreferenceEnvelope,
  parsePreferenceEnvelopeStrict,
  type PreferenceEnvelope,
} from "@/lib/theme/preferences";

export type InterfacePersistenceState = "loading" | "local" | "syncing" | "synced" | "error";

type ThemeContextValue = {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  interfaceSettings: InterfaceSettings;
  setInterfaceSettings: (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => void;
  interfacePersistence: InterfacePersistenceState;
  openInterfaceStudio: () => void;
  closeInterfaceStudio: () => void;
  interfaceStudioOpen: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_KEY = "axis-theme";
const SETTINGS_KEY = "axis-interface-settings";
const PREFERENCES_ROUTE = "/api/auth/preferences";
const UNSAFE_PREFERENCE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type ActiveRemoteLoad = {
  controller: AbortController;
  generation: number;
  ownershipGeneration: number;
  identity: symbol;
  subject: string | null;
};

type ActiveRemoteWrite = {
  controller: AbortController;
  generation: number;
  ownershipGeneration: number;
  identity: symbol;
  subject: string;
  envelope: PreferenceEnvelope;
  editRevision: number;
};

type QueuedRemoteWrite = {
  ownershipGeneration: number;
  subject: string;
  envelope: PreferenceEnvelope;
  editRevision: number;
};

type PendingPreferenceDraft = {
  subject: string;
  theme: ThemeMode;
  settings: InterfaceSettings;
};

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

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && ["dark", "dim", "light", "slate"].includes(value);
}

function parseStoredSettings(raw: string | null): InterfaceSettings | null {
  if (!raw) return null;
  try {
    return { ...DEFAULT_INTERFACE_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, entry]) =>
      !UNSAFE_PREFERENCE_KEYS.has(key) &&
      entry !== undefined &&
      isJsonValue(entry, depth + 1),
  );
}

function isPreferenceEnvelope(value: unknown): value is PreferenceEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

function isPreferenceReadResponse(
  value: unknown,
): value is { subject: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 && isProfileSubject(record.subject)
  );
}

function isPreferenceWriteResponse(
  value: unknown,
  subject: string,
): value is { ok: true; subject: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.ok === true &&
    record.subject === subject
  );
}

function isExactErrorResponse(value: unknown, error: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.error === error;
}

function capturePreferenceError(operation: "load" | "save", error: unknown) {
  Sentry.captureException(error instanceof Error ? error : new Error(`Interface preference ${operation} failed`), {
    tags: {
      area: "profile",
      provider: "supabase",
      operation,
    },
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), []);
  const [theme, setThemeState] = useState<ThemeMode>("dark");
  const [interfaceSettings, setInterfaceSettingsState] = useState<InterfaceSettings>(DEFAULT_INTERFACE_SETTINGS);
  const [interfacePersistence, setInterfacePersistence] = useState<InterfacePersistenceState>("loading");
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteSyncEnabled, setRemoteSyncEnabled] = useState(false);
  const [interfaceStudioOpen, setInterfaceStudioOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const themeValueRef = useRef<ThemeMode>(theme);
  const settingsValueRef = useRef<InterfaceSettings>(interfaceSettings);
  const remoteSubjectRef = useRef<string | null>(null);
  const quarantinedSubjectRef = useRef<string | null>(null);
  const pendingPreferenceDraftRef = useRef<PendingPreferenceDraft | null>(null);
  const remoteEnvelopeRef = useRef<PreferenceEnvelope>({});
  const remoteSyncEnabledRef = useRef(false);
  const remoteWriteIntentRef = useRef(false);
  const providerActiveRef = useRef(false);
  const pageActiveRef = useRef(true);
  const ownershipGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const writeGenerationRef = useRef(0);
  const editRevisionRef = useRef(0);
  const activeLoadRef = useRef<ActiveRemoteLoad | null>(null);
  const activeWriteRef = useRef<ActiveRemoteWrite | null>(null);
  const queuedWriteRef = useRef<QueuedRemoteWrite | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const runLoadRef = useRef<(() => void) | null>(null);
  const startNextWriteRef = useRef<(() => void) | null>(null);
  themeValueRef.current = theme;
  settingsValueRef.current = interfaceSettings;

  const retireActiveLoad = useCallback(() => {
    loadGenerationRef.current += 1;
    activeLoadRef.current?.controller.abort();
    activeLoadRef.current = null;
  }, []);

  const retireActiveWrite = useCallback(() => {
    writeGenerationRef.current += 1;
    if (writeTimerRef.current !== null) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    queuedWriteRef.current = null;
    activeWriteRef.current?.controller.abort();
    activeWriteRef.current = null;
  }, []);

  const quarantineRemoteOwnership = useCallback(
    (persistence: "loading" | "local" = "loading") => {
      ownershipGenerationRef.current += 1;
      retireActiveLoad();
      retireActiveWrite();
      if (remoteSubjectRef.current) {
        if (remoteWriteIntentRef.current) {
          pendingPreferenceDraftRef.current = {
            subject: remoteSubjectRef.current,
            theme: themeValueRef.current,
            settings: settingsValueRef.current,
          };
        }
        quarantinedSubjectRef.current = remoteSubjectRef.current;
      }
      remoteSubjectRef.current = null;
      remoteEnvelopeRef.current = {};
      remoteSyncEnabledRef.current = false;
      remoteWriteIntentRef.current = false;
      editRevisionRef.current = 0;
      setRemoteSyncEnabled(false);
      setRemoteReady(persistence === "local");
      setInterfacePersistence(persistence);
    },
    [retireActiveLoad, retireActiveWrite],
  );

  useEffect(() => {
    const stored = readStorage(THEME_KEY) as ThemeMode | null;
    if (isThemeMode(stored)) setThemeState(stored);
    const storedSettings = parseStoredSettings(readStorage(SETTINGS_KEY));
    if (storedSettings) setInterfaceSettingsState(storedSettings);
    setMounted(true);
    providerActiveRef.current = true;
    pageActiveRef.current = document.visibilityState !== "hidden";

    const isLoadCurrent = (operation: ActiveRemoteLoad) => {
      const active = activeLoadRef.current;
      return (
        providerActiveRef.current &&
        pageActiveRef.current &&
        !operation.controller.signal.aborted &&
        active === operation &&
        active.controller === operation.controller &&
        active.identity === operation.identity &&
        operation.generation === loadGenerationRef.current &&
        operation.ownershipGeneration === ownershipGenerationRef.current
      );
    };

    const commitLocalOnly = (operation: ActiveRemoteLoad) => {
      if (!isLoadCurrent(operation)) return;
      remoteSubjectRef.current = null;
      quarantinedSubjectRef.current = null;
      pendingPreferenceDraftRef.current = null;
      remoteEnvelopeRef.current = {};
      remoteSyncEnabledRef.current = false;
      remoteWriteIntentRef.current = false;
      editRevisionRef.current = 0;
      setRemoteSyncEnabled(false);
      setRemoteReady(true);
      setInterfacePersistence("local");
      activeLoadRef.current = null;
    };

    const loadRemotePreferences = async (operation: ActiveRemoteLoad) => {
      try {
        const response = await fetch(PREFERENCES_ROUTE, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: operation.controller.signal,
        });
        if (!isLoadCurrent(operation)) return;
        if (!response.ok) {
          const payload: unknown = await response.json();
          if (!isLoadCurrent(operation)) return;
          if (
            response.status === 401 &&
            isExactErrorResponse(payload, "UNAUTHENTICATED")
          ) {
            commitLocalOnly(operation);
            return;
          }
          if (
            (response.status === 499 &&
              isExactErrorResponse(payload, "REQUEST_ABORTED")) ||
            (response.status === 500 &&
              isExactErrorResponse(payload, "PREFERENCES_UNAVAILABLE"))
          ) {
            remoteSyncEnabledRef.current = false;
            setRemoteSyncEnabled(false);
            setRemoteReady(true);
            setInterfacePersistence("error");
            activeLoadRef.current = null;
            return;
          }
          throw new Error("Interface preference load failed unexpectedly");
        }

        const payload: unknown = await response.json();
        if (!isLoadCurrent(operation)) return;
        if (!isPreferenceReadResponse(payload)) {
          throw new Error("Interface preference response was invalid");
        }
        operation.subject = payload.subject;
        if (!isLoadCurrent(operation) || operation.subject !== payload.subject) {
          return;
        }

        // The server route is identity authority only. Once its opaque subject
        // is known, the browser performs the row read under Supabase RLS so the
        // request remains abortable and never carries a user UUID or filter.
        quarantinedSubjectRef.current = payload.subject;
        const { data, error } = await supabase
          .from("user_preferences")
          .select("interface_settings")
          .abortSignal(operation.controller.signal)
          .maybeSingle();
        if (!isLoadCurrent(operation)) return;
        if (error) {
          throw new Error("Interface preference RLS read failed");
        }
        const envelope = data?.interface_settings ?? {};
        if (!isPreferenceEnvelope(envelope)) {
          throw new Error("Interface preference RLS response was invalid");
        }

        const remote = parsePreferenceEnvelopeStrict(envelope);
        if (!remote) {
          throw new Error("Interface preference envelope was invalid");
        }
        const pendingDraft = pendingPreferenceDraftRef.current;
        const canRestorePendingDraft =
          pendingDraft?.subject === payload.subject;
        remoteSubjectRef.current = payload.subject;
        quarantinedSubjectRef.current = payload.subject;
        remoteEnvelopeRef.current = remote.envelope;
        pendingPreferenceDraftRef.current = null;
        if (canRestorePendingDraft && pendingDraft) {
          themeValueRef.current = pendingDraft.theme;
          settingsValueRef.current = pendingDraft.settings;
          setThemeState(pendingDraft.theme);
          setInterfaceSettingsState(pendingDraft.settings);
          remoteWriteIntentRef.current = true;
        } else {
          const nextTheme = remote.theme ?? "dark";
          const nextSettings = remote.settings ?? DEFAULT_INTERFACE_SETTINGS;
          themeValueRef.current = nextTheme;
          settingsValueRef.current = nextSettings;
          setThemeState(nextTheme);
          setInterfaceSettingsState(nextSettings);
          remoteWriteIntentRef.current = false;
          editRevisionRef.current = 0;
        }
        remoteSyncEnabledRef.current = true;
        setRemoteSyncEnabled(true);
        setRemoteReady(true);
        setInterfacePersistence("synced");
        activeLoadRef.current = null;
      } catch (error) {
        await deferFailureCommit();
        if (!isLoadCurrent(operation)) return;
        capturePreferenceError("load", error);
        remoteSyncEnabledRef.current = false;
        setRemoteSyncEnabled(false);
        setRemoteReady(true);
        setInterfacePersistence("error");
        activeLoadRef.current = null;
      }
    };

    const isWriteCurrent = (candidate: ActiveRemoteWrite) => {
      const active = activeWriteRef.current;
      return (
        providerActiveRef.current &&
        pageActiveRef.current &&
        remoteSyncEnabledRef.current &&
        !candidate.controller.signal.aborted &&
        active === candidate &&
        active.controller === candidate.controller &&
        active.identity === candidate.identity &&
        candidate.generation === writeGenerationRef.current &&
        candidate.ownershipGeneration === ownershipGenerationRef.current &&
        candidate.subject === remoteSubjectRef.current
      );
    };

    const startNextWrite = () => {
      if (
        activeWriteRef.current ||
        !providerActiveRef.current ||
        !pageActiveRef.current ||
        !remoteSyncEnabledRef.current
      ) {
        return;
      }
      const queued = queuedWriteRef.current;
      if (!queued) return;
      if (
        queued.ownershipGeneration !== ownershipGenerationRef.current ||
        queued.subject !== remoteSubjectRef.current
      ) {
        queuedWriteRef.current = null;
        return;
      }
      queuedWriteRef.current = null;
      const candidate: ActiveRemoteWrite = {
        controller: new AbortController(),
        generation: ++writeGenerationRef.current,
        ownershipGeneration: queued.ownershipGeneration,
        identity: Symbol("interface-preference-write"),
        subject: queued.subject,
        envelope: queued.envelope,
        editRevision: queued.editRevision,
      };
      activeWriteRef.current = candidate;
      setInterfacePersistence("syncing");

      const settleAndContinue = (saved: boolean) => {
        if (!isWriteCurrent(candidate)) return;
        activeWriteRef.current = null;
        if (saved) remoteEnvelopeRef.current = candidate.envelope;
        const next = queuedWriteRef.current;
        if (
          next &&
          next.ownershipGeneration === ownershipGenerationRef.current &&
          next.subject === remoteSubjectRef.current
        ) {
          startNextWrite();
          return;
        }
        if (saved && candidate.editRevision === editRevisionRef.current) {
          remoteWriteIntentRef.current = false;
          setInterfacePersistence("synced");
        } else if (saved) {
          setInterfacePersistence("syncing");
        }
      };

      const persistRemotePreferences = async () => {
        try {
          const saveResponse = await fetch(PREFERENCES_ROUTE, {
            method: "PUT",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              subject: candidate.subject,
              envelope: candidate.envelope,
            }),
            signal: candidate.controller.signal,
          });
          if (!isWriteCurrent(candidate)) return;
          const payload: unknown = await saveResponse.json();
          if (!isWriteCurrent(candidate)) return;
          if (!saveResponse.ok) {
            if (
              saveResponse.status === 401 &&
              isExactErrorResponse(payload, "UNAUTHENTICATED")
            ) {
              quarantineRemoteOwnership("local");
              return;
            }
            if (
              saveResponse.status === 409 &&
              isExactErrorResponse(payload, "PROFILE_SUBJECT_CHANGED")
            ) {
              quarantineRemoteOwnership("loading");
              runLoadRef.current?.();
              return;
            }
            if (
              (saveResponse.status === 499 &&
                isExactErrorResponse(payload, "REQUEST_ABORTED")) ||
              (saveResponse.status === 500 &&
                isExactErrorResponse(payload, "PREFERENCES_UNAVAILABLE"))
            ) {
              setInterfacePersistence("error");
              settleAndContinue(false);
              return;
            }
            throw new Error("Interface preference save failed unexpectedly");
          }
          if (!isPreferenceWriteResponse(payload, candidate.subject)) {
            throw new Error("Interface preference save response was invalid");
          }
          settleAndContinue(true);
        } catch (error) {
          await deferFailureCommit();
          if (!isWriteCurrent(candidate)) return;
          capturePreferenceError("save", error);
          setInterfacePersistence("error");
          settleAndContinue(false);
        }
      };

      void persistRemotePreferences();
    };
    startNextWriteRef.current = startNextWrite;

    const runLoad = () => {
      if (!providerActiveRef.current || !pageActiveRef.current) return;
      retireActiveLoad();
      const operation: ActiveRemoteLoad = {
        controller: new AbortController(),
        generation: ++loadGenerationRef.current,
        ownershipGeneration: ownershipGenerationRef.current,
        identity: Symbol("interface-preference-load"),
        subject: null,
      };
      activeLoadRef.current = operation;
      void loadRemotePreferences(operation);
    };
    runLoadRef.current = runLoad;

    const beginAuthoritativeReload = () => {
      quarantineRemoteOwnership("loading");
      runLoad();
    };
    const handlePageHide = () => {
      pageActiveRef.current = false;
      quarantineRemoteOwnership("loading");
    };
    const handlePageShow = () => {
      if (document.visibilityState === "hidden") {
        pageActiveRef.current = false;
        quarantineRemoteOwnership("loading");
        return;
      }
      const wasInactive = !pageActiveRef.current;
      pageActiveRef.current = true;
      if (!wasInactive) return;
      beginAuthoritativeReload();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") handlePageHide();
      else handlePageShow();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);

    // Auth events are transition signals only. The route response is the sole
    // identity authority, so every transition first quarantines prior ownership.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      if (!providerActiveRef.current) return;
      beginAuthoritativeReload();
    });

    beginAuthoritativeReload();

    return () => {
      providerActiveRef.current = false;
      pageActiveRef.current = false;
      runLoadRef.current = null;
      startNextWriteRef.current = null;
      retireActiveLoad();
      retireActiveWrite();
      remoteSubjectRef.current = null;
      quarantinedSubjectRef.current = null;
      pendingPreferenceDraftRef.current = null;
      remoteEnvelopeRef.current = {};
      remoteSyncEnabledRef.current = false;
      remoteWriteIntentRef.current = false;
      editRevisionRef.current = 0;
      subscription.unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [
    quarantineRemoteOwnership,
    retireActiveLoad,
    retireActiveWrite,
    supabase,
  ]);

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
    if (
      !mounted ||
      !remoteReady ||
      !remoteSyncEnabled ||
      !remoteWriteIntentRef.current
    ) {
      return;
    }
    const subject = remoteSubjectRef.current;
    if (!subject) return;
    const ownershipGeneration = ownershipGenerationRef.current;
    const envelope = buildPreferenceEnvelope(
      remoteEnvelopeRef.current,
      theme,
      interfaceSettings,
      getBrowserTimeZone(),
    );
    queuedWriteRef.current = {
      ownershipGeneration,
      subject,
      envelope,
      editRevision: editRevisionRef.current,
    };
    if (activeWriteRef.current) return;
    if (writeTimerRef.current !== null) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const timer = window.setTimeout(() => {
      writeTimerRef.current = null;
      if (
        !providerActiveRef.current ||
        !pageActiveRef.current ||
        !remoteSyncEnabledRef.current ||
        ownershipGeneration !== ownershipGenerationRef.current ||
        subject !== remoteSubjectRef.current
      ) {
        return;
      }
      startNextWriteRef.current?.();
    }, 450);
    writeTimerRef.current = timer;

    return () => {
      if (writeTimerRef.current === timer) {
        window.clearTimeout(timer);
        writeTimerRef.current = null;
      }
    };
  }, [
    interfaceSettings,
    mounted,
    remoteReady,
    remoteSyncEnabled,
    theme,
  ]);

  const setTheme = useCallback((t: ThemeMode) => {
    themeValueRef.current = t;
    if (remoteSyncEnabledRef.current && remoteSubjectRef.current) {
      editRevisionRef.current += 1;
      remoteWriteIntentRef.current = true;
    } else if (quarantinedSubjectRef.current) {
      editRevisionRef.current += 1;
      pendingPreferenceDraftRef.current = {
        subject: quarantinedSubjectRef.current,
        theme: t,
        settings: settingsValueRef.current,
      };
    }
    setThemeState(t);
  }, []);
  const setInterfaceSettings = useCallback(
    (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => {
      const next = typeof s === "function" ? s(settingsValueRef.current) : s;
      settingsValueRef.current = next;
      if (remoteSyncEnabledRef.current && remoteSubjectRef.current) {
        editRevisionRef.current += 1;
        remoteWriteIntentRef.current = true;
      } else if (quarantinedSubjectRef.current) {
        editRevisionRef.current += 1;
        pendingPreferenceDraftRef.current = {
          subject: quarantinedSubjectRef.current,
          theme: themeValueRef.current,
          settings: next,
        };
      }
      setInterfaceSettingsState(next);
    },
    [],
  );
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
