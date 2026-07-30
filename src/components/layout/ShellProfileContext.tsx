"use client";

import * as Sentry from "@sentry/nextjs";
import { usePathname } from "next/navigation";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "@/components/ui/Toast";

export const MAX_PROFILE_FIELD_LENGTH = 2_000;
const MAX_PROFILE_EMAIL_LENGTH = 320;
const AUTOSAVE_DEBOUNCE_MS = 600;

export type AccountState = "loading" | "signed-out" | "ready" | "error";
export type ProfileSaveState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"
  | "session-expired";

export type ShellProfile = {
  display_name: string | null;
  role_title: string | null;
  bio: string | null;
  avatar_url: string | null;
  email: string | null;
};

export type ProfileDraft = {
  name: string;
  role: string;
  bio: string;
  photo: string;
};

export type ShellProfileContextValue = {
  state: AccountState;
  profile: ShellProfile | null;
  draft: ProfileDraft;
  saveState: ProfileSaveState;
  hasPendingChanges: boolean;
  scheduleProfileSave: (draft: ProfileDraft) => void;
  retryProfileSave: () => void;
};

type SaveJob = {
  draft: ProfileDraft;
  generation: number;
};

const PROFILE_KEYS = [
  "display_name",
  "role_title",
  "bio",
  "avatar_url",
  "email",
] as const;

const EMPTY_DRAFT: ProfileDraft = {
  name: "",
  role: "",
  bio: "",
  photo: "",
};

export const ShellProfileContext =
  createContext<ShellProfileContextValue | null>(null);

function isBoundedNullableString(
  value: unknown,
  maxLength = MAX_PROFILE_FIELD_LENGTH,
) {
  return (
    value === null ||
    (typeof value === "string" && value.length <= maxLength)
  );
}

function isShellProfile(value: unknown): value is ShellProfile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === PROFILE_KEYS.length &&
    PROFILE_KEYS.every((key) =>
      isBoundedNullableString(
        record[key],
        key === "email" ? MAX_PROFILE_EMAIL_LENGTH : MAX_PROFILE_FIELD_LENGTH,
      ),
    )
  );
}

function isProfileWriteSuccess(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).ok === true
  );
}

function profileToDraft(profile: ShellProfile): ProfileDraft {
  return {
    name:
      profile.display_name || profile.email?.split("@")[0] || "Account",
    role: profile.role_title || profile.email || "",
    bio: profile.bio ?? "",
    photo: profile.avatar_url ?? "",
  };
}

function draftToProfile(
  draft: ProfileDraft,
  email: string | null,
): ShellProfile {
  return {
    display_name: draft.name.trim(),
    role_title: draft.role.trim(),
    bio: draft.bio.trim(),
    avatar_url: draft.photo.trim(),
    email,
  };
}

function captureShellProfileFailure() {
  Sentry.captureException(new Error("Shell profile lookup failed"), {
    tags: {
      area: "navigation",
      operation: "shell_profile_lookup",
    },
  });
}

function captureProfileSaveFailure(
  operation: "profile_save_network" | "profile_save_response",
) {
  Sentry.captureException(new Error("Profile save client failure"), {
    tags: {
      area: "navigation",
      operation,
    },
  });
}

export function ShellProfileProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { toast } = useToast();
  const [state, setState] = useState<AccountState>("loading");
  const [profile, setProfile] = useState<ShellProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [saveState, setSaveState] = useState<ProfileSaveState>("idle");
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const mountedRef = useRef(false);
  const profileRef = useRef<ShellProfile | null>(null);
  const draftRef = useRef<ProfileDraft>(EMPTY_DRAFT);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const blockedRef = useRef(false);
  const generationRef = useRef(0);
  const committedVersionRef = useRef(0);
  const lookupGenerationRef = useRef(0);
  const lookupFailureCapturedRef = useRef(false);
  const lastCapturedSaveFailureGenerationRef = useRef<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSaveRef = useRef<{
    controller: AbortController;
    job: SaveJob;
  } | null>(null);
  const queuedSaveRef = useRef<SaveJob | null>(null);
  const drainingSaveQueueRef = useRef(false);

  const setPending = useCallback((pending: boolean) => {
    pendingRef.current = pending;
    setHasPendingChanges(pending);
  }, []);

  const setCommittedProfile = useCallback((next: ShellProfile | null) => {
    profileRef.current = next;
    setProfile(next);
  }, []);

  const captureCurrentSaveFailure = useCallback(
    (
      job: SaveJob,
      operation: "profile_save_network" | "profile_save_response",
    ) => {
      if (
        job.generation !== generationRef.current ||
        lastCapturedSaveFailureGenerationRef.current === job.generation
      ) {
        return;
      }
      lastCapturedSaveFailureGenerationRef.current = job.generation;
      captureProfileSaveFailure(operation);
    },
    [],
  );

  const drainSaveQueue = useCallback(async () => {
    if (drainingSaveQueueRef.current || blockedRef.current) return;
    drainingSaveQueueRef.current = true;
    try {
      while (
        mountedRef.current &&
        !blockedRef.current &&
        queuedSaveRef.current
      ) {
        const job = queuedSaveRef.current;
        queuedSaveRef.current = null;
        const controller = new AbortController();
        activeSaveRef.current = { controller, job };
        if (job.generation === generationRef.current) {
          setSaveState("saving");
        }

        try {
          const response = await fetch("/api/auth/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(job.draft),
            signal: controller.signal,
          });
          if (!mountedRef.current) return;

          if (response.status === 401) {
            blockedRef.current = true;
            queuedSaveRef.current = {
              draft: draftRef.current,
              generation: generationRef.current,
            };
            setState("signed-out");
            setSaveState("session-expired");
            setPending(true);
            toast(
              "Your session expired. Sign in again to save profile changes.",
              "error",
              "Profile",
            );
            return;
          }

          if (!response.ok) {
            if (job.generation === generationRef.current) {
              setSaveState("error");
              setPending(true);
              toast("Profile changes were not saved", "error", "Profile");
            }
            continue;
          }

          let result: unknown;
          try {
            result = await response.json();
          } catch {
            result = null;
          }
          if (!isProfileWriteSuccess(result)) {
            captureCurrentSaveFailure(job, "profile_save_response");
            if (job.generation === generationRef.current) {
              setSaveState("error");
              setPending(true);
              toast("Profile changes were not saved", "error", "Profile");
            }
            continue;
          }

          committedVersionRef.current += 1;
          const committed = draftToProfile(
            job.draft,
            profileRef.current?.email ?? null,
          );
          setCommittedProfile(committed);
          lastCapturedSaveFailureGenerationRef.current = null;

          if (job.generation === generationRef.current) {
            const committedDraft = profileToDraft(committed);
            draftRef.current = committedDraft;
            setDraft(committedDraft);
            dirtyRef.current = false;
            setPending(false);
            setSaveState("saved");
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
              if (
                mountedRef.current &&
                !dirtyRef.current &&
                job.generation === generationRef.current
              ) {
                setSaveState("idle");
              }
            }, 2_000);
          }
        } catch (error) {
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          captureCurrentSaveFailure(job, "profile_save_network");
          if (job.generation === generationRef.current) {
            setSaveState("error");
            setPending(true);
            toast("Profile changes were not saved", "error", "Profile");
          }
        } finally {
          if (activeSaveRef.current?.controller === controller) {
            activeSaveRef.current = null;
          }
        }
      }
    } finally {
      drainingSaveQueueRef.current = false;
    }
  }, [
    captureCurrentSaveFailure,
    setCommittedProfile,
    setPending,
    toast,
  ]);

  const enqueueLatestDraft = useCallback(() => {
    if (!dirtyRef.current) return;
    queuedSaveRef.current = {
      draft: draftRef.current,
      generation: generationRef.current,
    };
    if (!blockedRef.current) void drainSaveQueue();
  }, [drainSaveQueue]);

  const scheduleProfileSave = useCallback(
    (nextDraft: ProfileDraft) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      dirtyRef.current = true;
      generationRef.current += 1;
      setPending(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSaveState(
        blockedRef.current ? "session-expired" : "pending",
      );
      debounceRef.current = setTimeout(() => {
        enqueueLatestDraft();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [enqueueLatestDraft, setPending],
  );

  const retryProfileSave = useCallback(() => {
    if (!dirtyRef.current) return;
    if (blockedRef.current) {
      toast(
        "Sign in again before retrying these profile changes.",
        "error",
        "Profile",
      );
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveState("pending");
    enqueueLatestDraft();
  }, [enqueueLatestDraft, toast]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lookupGenerationRef.current += 1;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      queuedSaveRef.current = null;
      activeSaveRef.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    const requestGeneration = ++lookupGenerationRef.current;
    const committedVersionAtStart = committedVersionRef.current;
    const controller = new AbortController();
    if (!profileRef.current) setState("loading");

    void (async () => {
      try {
        const response = await fetch("/api/auth/profile", {
          signal: controller.signal,
        });
        if (
          !mountedRef.current ||
          requestGeneration !== lookupGenerationRef.current
        ) {
          return;
        }

        if (response.status === 401) {
          lookupFailureCapturedRef.current = false;
          blockedRef.current = dirtyRef.current;
          setCommittedProfile(null);
          setState("signed-out");
          if (dirtyRef.current) {
            setSaveState("session-expired");
            setPending(true);
          }
          return;
        }
        if (!response.ok) {
          setState("error");
          return;
        }

        const nextProfile: unknown = await response.json();
        if (!isShellProfile(nextProfile)) {
          throw new Error("Invalid shell profile");
        }
        lookupFailureCapturedRef.current = false;
        if (
          !mountedRef.current ||
          requestGeneration !== lookupGenerationRef.current
        ) {
          return;
        }

        const wasBlocked = blockedRef.current;
        blockedRef.current = false;
        setState("ready");
        const canHydrateFromLookup =
          committedVersionAtStart === committedVersionRef.current;
        if (canHydrateFromLookup) {
          setCommittedProfile(nextProfile);
        }
        if (canHydrateFromLookup && !dirtyRef.current) {
          const nextDraft = profileToDraft(nextProfile);
          draftRef.current = nextDraft;
          setDraft(nextDraft);
          setSaveState("idle");
          setPending(false);
        } else if (wasBlocked) {
          setSaveState("error");
        }
      } catch (error) {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestGeneration !== lookupGenerationRef.current ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        if (!lookupFailureCapturedRef.current) {
          lookupFailureCapturedRef.current = true;
          captureShellProfileFailure();
        }
        setState("error");
      }
    })();

    return () => controller.abort();
  }, [pathname, setCommittedProfile, setPending]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  const value = useMemo<ShellProfileContextValue>(
    () => ({
      state,
      profile,
      draft,
      saveState,
      hasPendingChanges,
      scheduleProfileSave,
      retryProfileSave,
    }),
    [
      draft,
      hasPendingChanges,
      profile,
      retryProfileSave,
      saveState,
      scheduleProfileSave,
      state,
    ],
  );

  return (
    <ShellProfileContext.Provider value={value}>
      {children}
    </ShellProfileContext.Provider>
  );
}

export function useShellProfile() {
  const value = useContext(ShellProfileContext);
  if (!value) {
    throw new Error("useShellProfile must be used within ShellProfileProvider");
  }
  return value;
}
