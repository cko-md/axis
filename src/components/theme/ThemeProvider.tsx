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
  preferenceAuthAction,
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
  // `undefined` = auth has never settled. Distinguishing "not resolved yet" from
  // "resolved to signed-out" is what lets a repeat auth event be deduped without
  // swallowing the very first one.
  const settledForUserRef = useRef<string | null | undefined>(undefined);
  const writeVersionRef = useRef(0);
  const writeExecutorRef = useRef(createSerialExecutor());

  useEffect(() => {
    const stored = readStorage(THEME_KEY) as ThemeMode | null;
    if (isThemeMode(stored)) setThemeState(stored);
    const storedSettings = parseStoredSettings(readStorage(SETTINGS_KEY));
    if (storedSettings) setInterfaceSettingsState(storedSettings);
    setMounted(true);

    let cancelled = false;
    // Supersedes an in-flight load when auth changes again mid-request, so a
    // slow response for a previous account can never apply over a newer one.
    let loadToken = 0;

    const markLocalOnly = () => {
      remoteUserIdRef.current = null;
      remoteEnvelopeRef.current = {};
      setInterfacePersistence("local");
      setRemoteSyncEnabled(false);
      setRemoteReady(true);
    };

    const loadRemotePreferences = async () => {
      const token = ++loadToken;
      // Captured per invocation, not once per mount: each load must compare
      // against its own start so an edit made while THIS request was in flight
      // is preserved, while edits from before it are not treated as newer.
      const themeEpochAtLoad = themeEditEpochRef.current;
      const settingsEpochAtLoad = settingsEditEpochRef.current;

      // getUser(), never getSession() — the identity that selects the row must
      // stay server-verified.
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (cancelled || token !== loadToken) return;
      if (authError || !user) {
        if (authError) capturePreferenceError("load", authError);
        settledForUserRef.current = null;
        markLocalOnly();
        return;
      }

      const { data, error } = await supabase
        .from("user_preferences")
        .select("interface_settings")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled || token !== loadToken) return;
      if (error) {
        capturePreferenceError("load", error);
        // Deliberately not settled: a later auth event retries rather than
        // latching this account into a permanent error state.
        setInterfacePersistence("error");
        setRemoteSyncEnabled(false);
        setRemoteReady(true);
        return;
      }

      const remote = parsePreferenceEnvelope(data?.interface_settings);
      remoteUserIdRef.current = user.id;
      remoteEnvelopeRef.current = remote.envelope;
      settledForUserRef.current = user.id;
      if (
        remote.theme &&
        !fieldWasEditedSince(
          themeEpochAtLoad,
          themeEditEpochRef.current,
        )
      ) {
        setThemeState(remote.theme);
      }
      if (
        remote.settings &&
        !fieldWasEditedSince(
          settingsEpochAtLoad,
          settingsEditEpochRef.current,
        )
      ) {
        setInterfaceSettingsState(remote.settings);
      }
      setInterfacePersistence("synced");
      setRemoteSyncEnabled(true);
      setRemoteReady(true);
    };

    const runLoad = () => {
      loadRemotePreferences().catch(() => {
        if (!cancelled) {
          capturePreferenceError("load", new Error("Interface preference load failed"));
          setInterfacePersistence("error");
          setRemoteSyncEnabled(false);
          setRemoteReady(true);
        }
      });
    };

    // This provider lives in the root layout, so on the ordinary login path it
    // mounts while still signed out (middleware sends the first document request
    // to /login) and the app then signs in via a SOFT navigation — the provider
    // never remounts. Resolving auth only once at mount therefore pinned every
    // post-login session to local-only mode: the save effect below stays gated
    // on remoteSyncEnabled, so Interface Studio silently degraded to
    // localStorage and nothing was ever written to user_preferences.
    // Re-resolving on auth transitions is what makes preferences survive a
    // sign-in, an account switch, and a new device.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      const nextUserId = session?.user.id ?? null;
      // The session id is only a dedupe key here; getUser() remains the
      // authority on identity inside loadRemotePreferences.
      const action = preferenceAuthAction(event, nextUserId, settledForUserRef.current);
      if (action === "ignore") return;
      if (action === "reset-to-local") {
        loadToken += 1; // abandon anything in flight for the previous account
        settledForUserRef.current = null;
        markLocalOnly();
        return;
      }
      runLoad();
    });

    runLoad();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
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
