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
import type { Json } from "@/lib/supabase/database.types";
import {
  buildPreferenceEnvelope,
  createSerialExecutor,
  fieldWasEditedSince,
  parsePreferenceEnvelope,
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
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteSyncEnabled, setRemoteSyncEnabled] = useState(false);
  const [interfaceStudioOpen, setInterfaceStudioOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const themeEditEpochRef = useRef(0);
  const settingsEditEpochRef = useRef(0);
  const remoteUserIdRef = useRef<string | null>(null);
  const remoteEnvelopeRef = useRef<PreferenceEnvelope>({});
  const writeVersionRef = useRef(0);
  const writeExecutorRef = useRef(createSerialExecutor());

  useEffect(() => {
    const stored = readStorage(THEME_KEY) as ThemeMode | null;
    if (isThemeMode(stored)) setThemeState(stored);
    const storedSettings = parseStoredSettings(readStorage(SETTINGS_KEY));
    if (storedSettings) setInterfaceSettingsState(storedSettings);
    setMounted(true);

    let cancelled = false;
    const themeEpochAtHydration = themeEditEpochRef.current;
    const settingsEpochAtHydration = settingsEditEpochRef.current;
    const loadRemotePreferences = async () => {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (cancelled) return;
      if (authError || !user) {
        if (authError) capturePreferenceError("load", authError);
        setInterfacePersistence("local");
        setRemoteSyncEnabled(false);
        setRemoteReady(true);
        return;
      }

      const { data, error } = await supabase
        .from("user_preferences")
        .select("interface_settings")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        capturePreferenceError("load", error);
        setInterfacePersistence("error");
        setRemoteSyncEnabled(false);
        setRemoteReady(true);
        return;
      }

      const remote = parsePreferenceEnvelope(data?.interface_settings);
      remoteUserIdRef.current = user.id;
      remoteEnvelopeRef.current = remote.envelope;
      if (
        remote.theme &&
        !fieldWasEditedSince(
          themeEpochAtHydration,
          themeEditEpochRef.current,
        )
      ) {
        setThemeState(remote.theme);
      }
      if (
        remote.settings &&
        !fieldWasEditedSince(
          settingsEpochAtHydration,
          settingsEditEpochRef.current,
        )
      ) {
        setInterfaceSettingsState(remote.settings);
      }
      setInterfacePersistence("synced");
      setRemoteSyncEnabled(true);
      setRemoteReady(true);
    };

    loadRemotePreferences().catch(() => {
      if (!cancelled) {
        capturePreferenceError("load", new Error("Interface preference load failed"));
        setInterfacePersistence("error");
        setRemoteSyncEnabled(false);
        setRemoteReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [supabase]);

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
    if (!mounted || !remoteReady || !remoteSyncEnabled) return;
    let cancelled = false;
    const userId = remoteUserIdRef.current;
    if (!userId) return;
    const writeVersion = ++writeVersionRef.current;
    const envelope = buildPreferenceEnvelope(
      remoteEnvelopeRef.current,
      theme,
      interfaceSettings,
      getBrowserTimeZone(),
    );
    const persistRemotePreferences = async () => {
      if (cancelled) return;
      setInterfacePersistence("syncing");
      const { error } = await writeExecutorRef.current.enqueue(async () =>
        await supabase.from("user_preferences").upsert(
          {
            user_id: userId,
            interface_settings: envelope as Json,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        ),
      );
      if (!cancelled) {
        if (error) capturePreferenceError("save", error);
        if (!error) remoteEnvelopeRef.current = envelope;
        if (writeVersion === writeVersionRef.current) {
          setInterfacePersistence(error ? "error" : "synced");
        }
      }
    };

    const timer = window.setTimeout(() => {
      persistRemotePreferences().catch((error) => {
        if (!cancelled) {
          capturePreferenceError("save", error);
          setInterfacePersistence("error");
        }
      });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [interfaceSettings, mounted, remoteReady, remoteSyncEnabled, supabase, theme]);

  const setTheme = useCallback((t: ThemeMode) => {
    themeEditEpochRef.current += 1;
    setThemeState(t);
  }, []);
  const setInterfaceSettings = useCallback(
    (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => {
      settingsEditEpochRef.current += 1;
      setInterfaceSettingsState(s);
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
