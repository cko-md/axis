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
  editRevisionAtStart: number;
  editRevisionAtSubject: number | null;
  acceptsOwnershiplessEdits: boolean;
};

type ActiveRemoteWrite = {
  controller: AbortController;
  generation: number;
  ownershipGeneration: number;
  identity: symbol;
  subject: string;
  envelope: PreferenceEnvelope;
  editRevision: number;
  themeEditRevision: number;
  settingsEditRevision: number;
};

type QueuedRemoteWrite = {
  ownershipGeneration: number;
  subject: string;
  envelope: PreferenceEnvelope;
  editRevision: number;
  themeEditRevision: number;
  settingsEditRevision: number;
};

type DirtyPreferenceField<T> = {
  value: T;
  revision: number;
};

type PendingPreferenceFields = {
  theme?: DirtyPreferenceField<ThemeMode>;
  settings?: DirtyPreferenceField<InterfaceSettings>;
};

type SubjectPendingPreferenceFields = PendingPreferenceFields & {
  subject: string;
};

type PreferenceFailureStage =
  | "request"
  | "response-body"
  | "response-status"
  | "contract"
  | "rls";

type PreferenceFailureTransport = "direct" | "route";

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
): value is { subject: string; envelope: PreferenceEnvelope } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    isProfileSubject(record.subject) &&
    isPreferenceEnvelope(record.envelope)
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

class PreferenceClientError extends Error {
  readonly safeStatus: number;
  readonly safeCode: "PROFILE_LOAD_FAILED" | "PROFILE_SAVE_FAILED";
  readonly safeStage: PreferenceFailureStage;
  readonly safeTransport: PreferenceFailureTransport;

  constructor(
    operation: "load" | "save",
    transport: PreferenceFailureTransport,
    stage: PreferenceFailureStage,
    status: number,
  ) {
    const code = operation === "load"
      ? "PROFILE_LOAD_FAILED"
      : "PROFILE_SAVE_FAILED";
    super(code);
    this.name = "PreferenceClientError";
    this.safeCode = code;
    this.safeStage = stage;
    this.safeStatus =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : stage === "request" || stage === "rls"
          ? 503
          : 502;
    this.safeTransport = transport;
  }
}

class DirectPreferenceReadError extends PreferenceClientError {
  constructor(error: unknown) {
    const record = typeof error === "object" && error !== null
      ? error as Record<string, unknown>
      : {};
    const status =
      typeof record.status === "number" &&
      Number.isInteger(record.status) &&
      record.status >= 400 &&
      record.status <= 599
        ? record.status
        : 500;
    super("load", "direct", "rls", status);
    this.name = "DirectPreferenceReadError";
  }
}

function capturePreferenceError(operation: "load" | "save", error: unknown) {
  const safeError = error instanceof PreferenceClientError
    ? error
    : new PreferenceClientError(operation, "route", "request", 503);
  const directRead = {
    status: safeError.safeStatus,
    code: safeError.safeCode,
    transport: safeError.safeTransport,
    stage: safeError.safeStage,
  };
  Sentry.captureException(safeError, {
    tags: {
      area: "profile",
      provider: "supabase",
      operation,
      ...directRead,
    },
  });
}

function deferPreferenceFailureCommit(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let frame = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      if (frame) window.cancelAnimationFrame(frame);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    frame = window.requestAnimationFrame(finish);
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
  const ownershiplessEditsRef = useRef<PendingPreferenceFields | null>(null);
  const subjectEditsRef = useRef<SubjectPendingPreferenceFields | null>(null);
  const remoteEnvelopeRef = useRef<PreferenceEnvelope>({});
  const remoteSyncEnabledRef = useRef(false);
  const remoteWriteIntentRef = useRef(false);
  const loadFailureReportedRef = useRef(false);
  const writeFailureSubjectRef = useRef<string | null>(null);
  const themeDirtyRef = useRef(false);
  const settingsDirtyRef = useRef(false);
  const providerActiveRef = useRef(false);
  const pageActiveRef = useRef(true);
  const ownershipGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const writeGenerationRef = useRef(0);
  const editRevisionRef = useRef(0);
  const themeEditRevisionRef = useRef(0);
  const settingsEditRevisionRef = useRef(0);
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
          const existing = subjectEditsRef.current?.subject === remoteSubjectRef.current
            ? subjectEditsRef.current
            : { subject: remoteSubjectRef.current };
          subjectEditsRef.current = {
            ...existing,
            ...(themeDirtyRef.current
              ? {
                  theme: {
                    value: themeValueRef.current,
                    revision: themeEditRevisionRef.current,
                  },
                }
              : {}),
            ...(settingsDirtyRef.current
              ? {
                  settings: {
                    value: settingsValueRef.current,
                    revision: settingsEditRevisionRef.current,
                  },
                }
              : {}),
          };
        }
        quarantinedSubjectRef.current = remoteSubjectRef.current;
      }
      remoteSubjectRef.current = null;
      remoteEnvelopeRef.current = {};
      remoteSyncEnabledRef.current = false;
      remoteWriteIntentRef.current = false;
      themeDirtyRef.current = false;
      settingsDirtyRef.current = false;
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
      ownershiplessEditsRef.current = null;
      subjectEditsRef.current = null;
      remoteEnvelopeRef.current = {};
      remoteSyncEnabledRef.current = false;
      remoteWriteIntentRef.current = false;
      loadFailureReportedRef.current = false;
      writeFailureSubjectRef.current = null;
      themeDirtyRef.current = false;
      settingsDirtyRef.current = false;
      setRemoteSyncEnabled(false);
      setRemoteReady(true);
      setInterfacePersistence("local");
      activeLoadRef.current = null;
    };

    const readAuthoritativePreferences = async (operation: ActiveRemoteLoad) => {
      let response: Response;
      try {
        response = await fetch(PREFERENCES_ROUTE, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: operation.controller.signal,
        });
      } catch {
        throw new PreferenceClientError("load", "route", "request", 503);
      }
      if (!isLoadCurrent(operation)) return null;
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new PreferenceClientError(
            "load",
            "route",
            "response-body",
            response.status >= 400 ? response.status : 502,
          );
        }
        if (!isLoadCurrent(operation)) return null;
        if (
          response.status === 401 &&
          isExactErrorResponse(payload, "UNAUTHENTICATED")
        ) {
          commitLocalOnly(operation);
          return null;
        }
        if (
          (response.status === 499 &&
            isExactErrorResponse(payload, "REQUEST_ABORTED")) ||
          (response.status === 500 &&
            isExactErrorResponse(payload, "PREFERENCES_UNAVAILABLE"))
        ) {
          if (response.status === 500) loadFailureReportedRef.current = true;
          remoteSyncEnabledRef.current = false;
          setRemoteSyncEnabled(false);
          setRemoteReady(true);
          setInterfacePersistence("error");
          activeLoadRef.current = null;
          return null;
        }
        throw new PreferenceClientError(
          "load",
          "route",
          "response-status",
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new PreferenceClientError("load", "route", "response-body", 502);
      }
      if (!isLoadCurrent(operation)) return null;
      if (!isPreferenceReadResponse(payload)) {
        throw new PreferenceClientError("load", "route", "contract", 502);
      }
      return payload;
    };

    const loadRemotePreferences = async (operation: ActiveRemoteLoad) => {
      try {
        const initialIdentity = await readAuthoritativePreferences(operation);
        if (!isLoadCurrent(operation) || !initialIdentity) return;
        const initialSubject = initialIdentity.subject;
        operation.subject = initialSubject;
        operation.editRevisionAtSubject = editRevisionRef.current;
        if (
          !isLoadCurrent(operation) ||
          operation.subject !== initialSubject ||
          operation.editRevisionAtSubject < operation.editRevisionAtStart
        ) {
          return;
        }

        // S1 establishes opaque identity. The browser RLS read remains the
        // abortable readiness/error gate but its ownerless data is never used;
        // only the matching post-read server response (S2) supplies the row.
        quarantinedSubjectRef.current = initialSubject;
        let directRead: { error: unknown };
        try {
          directRead = await supabase
            .from("user_preferences")
            .select("interface_settings")
            .abortSignal(operation.controller.signal)
            .maybeSingle();
        } catch {
          throw new PreferenceClientError("load", "direct", "rls", 503);
        }
        if (!isLoadCurrent(operation)) return;
        if (directRead.error) {
          throw new DirectPreferenceReadError(directRead.error);
        }

        const confirmedIdentity = await readAuthoritativePreferences(operation);
        if (!isLoadCurrent(operation) || !confirmedIdentity) return;
        if (confirmedIdentity.subject !== initialSubject) {
          quarantineRemoteOwnership("loading");
          runLoadRef.current?.();
          return;
        }
        const confirmedSubject = confirmedIdentity.subject;

        const remote = parsePreferenceEnvelopeStrict(
          confirmedIdentity.envelope,
        );
        if (!remote) {
          throw new PreferenceClientError("load", "route", "contract", 502);
        }
        const subjectEdits =
          subjectEditsRef.current?.subject === confirmedSubject
            ? subjectEditsRef.current
            : null;
        const ownershiplessEdits = operation.acceptsOwnershiplessEdits
          ? ownershiplessEditsRef.current
          : null;
        const themeEdit = subjectEdits?.theme ?? ownershiplessEdits?.theme;
        const settingsEdit =
          subjectEdits?.settings ?? ownershiplessEdits?.settings;
        const editedDuringRead =
          operation.editRevisionAtSubject !== editRevisionRef.current;
        if (editedDuringRead && !themeEdit && !settingsEdit) {
          quarantineRemoteOwnership("loading");
          runLoadRef.current?.();
          return;
        }
        remoteSubjectRef.current = confirmedSubject;
        quarantinedSubjectRef.current = confirmedSubject;
        remoteEnvelopeRef.current = remote.envelope;
        subjectEditsRef.current = null;
        if (operation.acceptsOwnershiplessEdits) {
          ownershiplessEditsRef.current = null;
        }
        const nextTheme = themeEdit?.value ?? remote.theme ?? "dark";
        const nextSettings =
          settingsEdit?.value ??
          remote.settings ??
          DEFAULT_INTERFACE_SETTINGS;
        themeValueRef.current = nextTheme;
        settingsValueRef.current = nextSettings;
        setThemeState(nextTheme);
        setInterfaceSettingsState(nextSettings);
        themeDirtyRef.current = Boolean(themeEdit);
        settingsDirtyRef.current = Boolean(settingsEdit);
        remoteWriteIntentRef.current = Boolean(themeEdit || settingsEdit);
        remoteSyncEnabledRef.current = true;
        loadFailureReportedRef.current = false;
        if (writeFailureSubjectRef.current !== confirmedSubject) {
          writeFailureSubjectRef.current = null;
        }
        setRemoteSyncEnabled(true);
        setRemoteReady(true);
        setInterfacePersistence("synced");
        activeLoadRef.current = null;
      } catch (error) {
        await deferPreferenceFailureCommit(operation.controller.signal);
        if (!isLoadCurrent(operation)) return;
        if (!loadFailureReportedRef.current) {
          loadFailureReportedRef.current = true;
          capturePreferenceError("load", error);
        }
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
        themeEditRevision: queued.themeEditRevision,
        settingsEditRevision: queued.settingsEditRevision,
      };
      activeWriteRef.current = candidate;
      setInterfacePersistence("syncing");

      const settleAndContinue = (saved: boolean) => {
        if (!isWriteCurrent(candidate)) return;
        activeWriteRef.current = null;
        if (saved) {
          remoteEnvelopeRef.current = candidate.envelope;
          if (
            candidate.themeEditRevision === themeEditRevisionRef.current
          ) {
            themeDirtyRef.current = false;
          }
          if (
            candidate.settingsEditRevision === settingsEditRevisionRef.current
          ) {
            settingsDirtyRef.current = false;
          }
        }
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
          let saveResponse: Response;
          try {
            saveResponse = await fetch(PREFERENCES_ROUTE, {
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
          } catch {
            throw new PreferenceClientError("save", "route", "request", 503);
          }
          if (!isWriteCurrent(candidate)) return;
          let payload: unknown;
          try {
            payload = await saveResponse.json();
          } catch {
            throw new PreferenceClientError(
              "save",
              "route",
              "response-body",
              saveResponse.ok ? 502 : saveResponse.status,
            );
          }
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
              if (saveResponse.status === 500) {
                writeFailureSubjectRef.current = candidate.subject;
              }
              setInterfacePersistence("error");
              settleAndContinue(false);
              return;
            }
            throw new PreferenceClientError(
              "save",
              "route",
              "response-status",
              saveResponse.status,
            );
          }
          if (!isPreferenceWriteResponse(payload, candidate.subject)) {
            throw new PreferenceClientError("save", "route", "contract", 502);
          }
          writeFailureSubjectRef.current = null;
          settleAndContinue(true);
        } catch (error) {
          await deferPreferenceFailureCommit(candidate.controller.signal);
          if (!isWriteCurrent(candidate)) return;
          if (writeFailureSubjectRef.current !== candidate.subject) {
            writeFailureSubjectRef.current = candidate.subject;
            capturePreferenceError("save", error);
          }
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
        editRevisionAtStart: editRevisionRef.current,
        editRevisionAtSubject: null,
        acceptsOwnershiplessEdits:
          quarantinedSubjectRef.current === null ||
          ownershiplessEditsRef.current !== null,
      };
      activeLoadRef.current = operation;
      void loadRemotePreferences(operation);
    };
    runLoadRef.current = runLoad;

    const beginAuthoritativeReload = () => {
      quarantineRemoteOwnership("loading");
      runLoad();
    };
    const retireForCrossDocumentNavigation = () => {
      pageActiveRef.current = false;
      retireActiveLoad();
      retireActiveWrite();
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
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !activeLoadRef.current &&
        !activeWriteRef.current &&
        !queuedWriteRef.current &&
        writeTimerRef.current === null
      ) {
        return;
      }
      retireForCrossDocumentNavigation();
      // A dirty-state guard can cancel beforeunload. If the user stays, its
      // timer resumes and this document must re-establish authority. If the
      // user leaves, the document is destroyed before the recovery can run.
      window.setTimeout(() => {
        if (
          event.defaultPrevented &&
          providerActiveRef.current &&
          document.visibilityState !== "hidden"
        ) {
          pageActiveRef.current = true;
          beginAuthoritativeReload();
        }
      }, 0);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    // Cross-document navigation begins here in hosted Chromium. Retire only
    // exact operations; pagehide remains responsible for draft quarantine.
    window.addEventListener("beforeunload", handleBeforeUnload);
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
      ownershiplessEditsRef.current = null;
      subjectEditsRef.current = null;
      remoteEnvelopeRef.current = {};
      remoteSyncEnabledRef.current = false;
      remoteWriteIntentRef.current = false;
      themeDirtyRef.current = false;
      settingsDirtyRef.current = false;
      loadFailureReportedRef.current = false;
      writeFailureSubjectRef.current = null;
      subscription.unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
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
      themeEditRevision: themeEditRevisionRef.current,
      settingsEditRevision: settingsEditRevisionRef.current,
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
    editRevisionRef.current += 1;
    themeEditRevisionRef.current += 1;
    const edit = {
      value: t,
      revision: themeEditRevisionRef.current,
    };
    if (remoteSyncEnabledRef.current && remoteSubjectRef.current) {
      themeDirtyRef.current = true;
      remoteWriteIntentRef.current = true;
    } else {
      const activeLoad = activeLoadRef.current;
      const subject =
        activeLoad &&
        !activeLoad.controller.signal.aborted &&
        activeLoad.generation === loadGenerationRef.current &&
        activeLoad.ownershipGeneration === ownershipGenerationRef.current
          ? activeLoad.subject ?? quarantinedSubjectRef.current
          : quarantinedSubjectRef.current;
      if (subject) {
        const existing = subjectEditsRef.current?.subject === subject
          ? subjectEditsRef.current
          : { subject };
        subjectEditsRef.current = {
          ...existing,
          theme: edit,
        };
      } else {
        ownershiplessEditsRef.current = {
          ...ownershiplessEditsRef.current,
          theme: edit,
        };
      }
    }
    setThemeState(t);
  }, []);
  const setInterfaceSettings = useCallback(
    (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => {
      const next = typeof s === "function" ? s(settingsValueRef.current) : s;
      settingsValueRef.current = next;
      editRevisionRef.current += 1;
      settingsEditRevisionRef.current += 1;
      const edit = {
        value: next,
        revision: settingsEditRevisionRef.current,
      };
      if (remoteSyncEnabledRef.current && remoteSubjectRef.current) {
        settingsDirtyRef.current = true;
        remoteWriteIntentRef.current = true;
      } else {
        const activeLoad = activeLoadRef.current;
        const subject =
          activeLoad &&
          !activeLoad.controller.signal.aborted &&
          activeLoad.generation === loadGenerationRef.current &&
          activeLoad.ownershipGeneration === ownershipGenerationRef.current
            ? activeLoad.subject ?? quarantinedSubjectRef.current
            : quarantinedSubjectRef.current;
        if (subject) {
          const existing = subjectEditsRef.current?.subject === subject
            ? subjectEditsRef.current
            : { subject };
          subjectEditsRef.current = {
            ...existing,
            settings: edit,
          };
        } else {
          ownershiplessEditsRef.current = {
            ...ownershiplessEditsRef.current,
            settings: edit,
          };
        }
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
