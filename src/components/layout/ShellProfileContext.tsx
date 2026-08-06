"use client";

import * as Sentry from "@sentry/nextjs";
import { deferFailureCommit } from "@/lib/observability/deferFailureCommit";
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
import type { Area } from "react-easy-crop";
import { useToast } from "@/components/ui/Toast";
import { isProfileSubject } from "@/lib/auth/profileSubject";
import { getCroppedImageBlob } from "@/components/nav/cropImage";

export const MAX_PROFILE_FIELD_LENGTH = 2_000;
const MAX_PROFILE_EMAIL_LENGTH = 320;
const AUTOSAVE_DEBOUNCE_MS = 600;

export type AccountState =
  | "loading"
  | "signed-out"
  | "mfa-required"
  | "ready"
  | "error";
export type ProfileSaveState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"
  | "session-expired"
  | "mfa-required";
export type ProfileUploadState =
  | "idle"
  | "processing"
  | "uploading"
  | "error"
  | "mfa-required";

export type ShellProfile = {
  subject: string;
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
  uploadState: ProfileUploadState;
  hasPendingChanges: boolean;
  scheduleProfileSave: (draft: ProfileDraft) => void;
  retryProfileSave: () => void;
  uploadProfilePhoto: (
    file: File | Blob,
    expectedSubject: string,
  ) => Promise<void>;
  processAndUploadProfilePhoto: (
    imageSrc: string,
    crop: Area,
    expectedSubject: string,
  ) => Promise<void>;
  cancelProfilePhotoProcessing: (expectedSubject: string) => void;
};

type SaveJob = {
  subject: string;
  draft: ProfileDraft;
  generation: number;
  epoch: number;
};

type SubjectDraftRecord = {
  draft: ProfileDraft;
  dirty: boolean;
  generation: number;
};

type BlockedReason = "signed-out" | "mfa-required" | "subject-changed" | null;

type ActiveSaveOperation = {
  controller: AbortController;
  job: SaveJob;
  identity: symbol;
};

type ActiveAvatarOperation = {
  controller: AbortController;
  subject: string;
  generation: number;
  identity: symbol;
};

type ActiveLookupOperation = {
  controller: AbortController;
  generation: number;
  subjectAtStart: string | null;
  identity: symbol;
};

const PROFILE_KEYS = [
  "subject",
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === PROFILE_KEYS.length &&
    isProfileSubject(record.subject) &&
    PROFILE_KEYS.slice(1).every((key) =>
      isBoundedNullableString(
        record[key],
        key === "email" ? MAX_PROFILE_EMAIL_LENGTH : MAX_PROFILE_FIELD_LENGTH,
      ),
    )
  );
}

function isMfaRequiredPayload(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).error === "MFA_REQUIRED"
  );
}

function isProfileWriteSuccess(
  value: unknown,
  subject: string,
): value is { ok: true; subject: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    (value as Record<string, unknown>).ok === true &&
    (value as Record<string, unknown>).subject === subject
  );
}

function isAvatarUploadSuccess(
  value: unknown,
  subject: string,
): value is { url: string; subject: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof (value as Record<string, unknown>).url === "string" &&
    ((value as Record<string, unknown>).url as string).length <=
      MAX_PROFILE_FIELD_LENGTH &&
    (value as Record<string, unknown>).subject === subject
  );
}

function isAbortError(error: unknown) {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function responseRequiresMfa(response: Response) {
  if (response.status !== 403) return false;
  try {
    return isMfaRequiredPayload(await response.json());
  } catch (error) {
    if (isAbortError(error)) throw error;
    return false;
  }
}

async function consumeResponseBody(response: Response) {
  try {
    return await response.json() as unknown;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
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
  subject: string,
  draft: ProfileDraft,
  email: string | null,
): ShellProfile {
  return {
    subject,
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

function captureProfileClientFailure(
  operation:
    | "profile_save_network"
    | "profile_save_response"
    | "profile_avatar_upload_network"
    | "profile_avatar_upload_response"
    | "profile_avatar_crop",
) {
  Sentry.captureException(new Error("Profile client operation failed"), {
    tags: {
      area: "navigation",
      operation,
    },
  });
}

export function ShellProfileProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { toast } = useToast();
  const [lookupNonce, setLookupNonce] = useState(0);
  const [state, setState] = useState<AccountState>("loading");
  const [profile, setProfile] = useState<ShellProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [saveState, setSaveState] = useState<ProfileSaveState>("idle");
  const [uploadState, setUploadState] =
    useState<ProfileUploadState>("idle");
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const mountedRef = useRef(false);
  const pageActiveRef = useRef(true);
  const subjectRef = useRef<string | null>(null);
  const profileRef = useRef<ShellProfile | null>(null);
  const draftRef = useRef<ProfileDraft>(EMPTY_DRAFT);
  const dirtyRef = useRef(false);
  const draftPendingRef = useRef(false);
  const uploadPendingRef = useRef(false);
  const generationRef = useRef(0);
  const blockedReasonRef = useRef<BlockedReason>(null);
  const subjectDraftsRef = useRef(new Map<string, SubjectDraftRecord>());
  const committedVersionsRef = useRef(new Map<string, number>());
  const lookupGenerationRef = useRef(0);
  const lookupFailureCapturedRef = useRef(false);
  const lastCapturedSaveFailureRef = useRef<string | null>(null);
  const lastCapturedUploadFailureRef = useRef<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveEpochRef = useRef(0);
  const drainingEpochRef = useRef<number | null>(null);
  const activeSaveRef = useRef<ActiveSaveOperation | null>(null);
  const queuedSaveRef = useRef<SaveJob | null>(null);
  const uploadGenerationRef = useRef(0);
  const activeAvatarRef = useRef<ActiveAvatarOperation | null>(null);
  const activeLookupRef = useRef<ActiveLookupOperation | null>(null);

  const syncPendingState = useCallback(() => {
    setHasPendingChanges(
      draftPendingRef.current || uploadPendingRef.current,
    );
  }, []);

  const setDraftPending = useCallback(
    (pending: boolean) => {
      draftPendingRef.current = pending;
      syncPendingState();
    },
    [syncPendingState],
  );

  const setUploadPending = useCallback(
    (pending: boolean) => {
      uploadPendingRef.current = pending;
      syncPendingState();
    },
    [syncPendingState],
  );

  const setCommittedProfile = useCallback((next: ShellProfile | null) => {
    profileRef.current = next;
    setProfile(next);
  }, []);

  const storeCurrentSubjectDraft = useCallback(() => {
    const subject = subjectRef.current;
    if (!subject) return;
    subjectDraftsRef.current.set(subject, {
      draft: draftRef.current,
      dirty: dirtyRef.current,
      generation: generationRef.current,
    });
  }, []);

  const cancelSubjectWork = useCallback((updateUi = true) => {
    saveEpochRef.current += 1;
    drainingEpochRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    queuedSaveRef.current = null;
    activeSaveRef.current?.controller.abort();
    activeSaveRef.current = null;
    uploadGenerationRef.current += 1;
    activeAvatarRef.current?.controller.abort();
    activeAvatarRef.current = null;
    uploadPendingRef.current = false;
    if (updateUi) {
      syncPendingState();
      setUploadState("idle");
    }
  }, [syncPendingState]);

  const isSaveOperationCurrent = useCallback(
    (operation: ActiveSaveOperation) => {
      const activeOperation = activeSaveRef.current;
      return (
        mountedRef.current &&
        !operation.controller.signal.aborted &&
        activeOperation === operation &&
        activeOperation.controller === operation.controller &&
        activeOperation.identity === operation.identity &&
        subjectRef.current === operation.job.subject &&
        saveEpochRef.current === operation.job.epoch &&
        generationRef.current === operation.job.generation
      );
    },
    [],
  );

  const isAvatarOperationCurrent = useCallback(
    (operation: ActiveAvatarOperation) => {
      const activeOperation = activeAvatarRef.current;
      return (
        mountedRef.current &&
        !operation.controller.signal.aborted &&
        activeOperation === operation &&
        activeOperation.controller === operation.controller &&
        activeOperation.identity === operation.identity &&
        subjectRef.current === operation.subject &&
        uploadGenerationRef.current === operation.generation
      );
    },
    [],
  );

  const isLookupOperationCurrent = useCallback(
    (operation: ActiveLookupOperation) => {
      const activeOperation = activeLookupRef.current;
      return (
        mountedRef.current &&
        pageActiveRef.current &&
        !operation.controller.signal.aborted &&
        activeOperation === operation &&
        activeOperation.controller === operation.controller &&
        activeOperation.identity === operation.identity &&
        lookupGenerationRef.current === operation.generation &&
        subjectRef.current === operation.subjectAtStart
      );
    },
    [],
  );

  const captureCurrentSaveFailure = useCallback(
    (
      job: SaveJob,
      operation: "profile_save_network" | "profile_save_response",
    ) => {
      const key = `${job.subject}:${job.generation}`;
      if (
        job.subject !== subjectRef.current ||
        job.generation !== generationRef.current ||
        lastCapturedSaveFailureRef.current === key
      ) {
        return;
      }
      lastCapturedSaveFailureRef.current = key;
      captureProfileClientFailure(operation);
    },
    [],
  );

  const scheduleForSubject = useCallback(
    (subject: string, nextDraft: ProfileDraft) => {
      if (subject !== subjectRef.current) return false;
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      dirtyRef.current = true;
      generationRef.current += 1;
      if (
        queuedSaveRef.current?.subject === subject &&
        queuedSaveRef.current.generation < generationRef.current
      ) {
        queuedSaveRef.current = null;
      }
      lastCapturedSaveFailureRef.current = null;
      subjectDraftsRef.current.set(subject, {
        draft: nextDraft,
        dirty: true,
        generation: generationRef.current,
      });
      setDraftPending(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSaveState(
        blockedReasonRef.current === "signed-out"
          ? "session-expired"
          : blockedReasonRef.current === "mfa-required"
            ? "mfa-required"
            : "pending",
      );
      const generation = generationRef.current;
      const epoch = saveEpochRef.current;
      debounceRef.current = setTimeout(() => {
        if (
          subjectRef.current !== subject ||
          generationRef.current !== generation ||
          saveEpochRef.current !== epoch ||
          !dirtyRef.current
        ) {
          return;
        }
        queuedSaveRef.current = {
          subject,
          draft: draftRef.current,
          generation,
          epoch,
        };
        if (!blockedReasonRef.current) {
          void drainSaveQueueRef.current();
        }
      }, AUTOSAVE_DEBOUNCE_MS);
      return true;
    },
    [setDraftPending],
  );

  const drainSaveQueueRef = useRef<() => Promise<void>>(async () => {});

  const drainSaveQueue = useCallback(async () => {
    const epoch = saveEpochRef.current;
    if (
      drainingEpochRef.current === epoch ||
      blockedReasonRef.current
    ) {
      return;
    }
    drainingEpochRef.current = epoch;
    try {
      while (
        mountedRef.current &&
        saveEpochRef.current === epoch &&
        !blockedReasonRef.current &&
        queuedSaveRef.current
      ) {
        const job = queuedSaveRef.current;
        queuedSaveRef.current = null;
        if (
          job.epoch !== epoch ||
          job.subject !== subjectRef.current
        ) {
          continue;
        }

        const controller = new AbortController();
        const operation: ActiveSaveOperation = {
          controller,
          job,
          identity: Symbol("profile-save"),
        };
        activeSaveRef.current = operation;
        if (job.generation === generationRef.current) {
          setSaveState("saving");
        }

        try {
          const response = await fetch("/api/auth/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              subject: job.subject,
              ...job.draft,
            }),
            signal: controller.signal,
          });
          if (!isSaveOperationCurrent(operation)) continue;

          if (response.status === 401) {
            blockedReasonRef.current = "signed-out";
            queuedSaveRef.current = {
              ...job,
              draft: draftRef.current,
              generation: generationRef.current,
            };
            setCommittedProfile(null);
            setState("signed-out");
            setSaveState("session-expired");
            setDraftPending(true);
            toast(
              "Your session expired. Sign in again to save profile changes.",
              "error",
              "Profile",
            );
            return;
          }

          let bodyWasConsumed = false;
          if (response.status === 403) {
            const requiresMfa = await responseRequiresMfa(response);
            if (!isSaveOperationCurrent(operation)) continue;
            bodyWasConsumed = true;
            if (requiresMfa) {
              blockedReasonRef.current = "mfa-required";
              queuedSaveRef.current = {
                ...job,
                draft: draftRef.current,
                generation: generationRef.current,
              };
              setState("mfa-required");
              setSaveState("mfa-required");
              setDraftPending(true);
              toast(
                "Complete two-factor authentication to save profile changes.",
                "error",
                "Profile",
              );
              return;
            }
          }

          if (response.status === 409) {
            if (!bodyWasConsumed) {
              await consumeResponseBody(response);
              if (!isSaveOperationCurrent(operation)) continue;
            }
            blockedReasonRef.current = "subject-changed";
            setCommittedProfile(null);
            setState("loading");
            setSaveState("error");
            setDraftPending(true);
            storeCurrentSubjectDraft();
            toast(
              "The signed-in account changed. These profile changes were not applied.",
              "error",
              "Profile",
            );
            setLookupNonce((value) => value + 1);
            return;
          }

          if (!response.ok) {
            if (!bodyWasConsumed) {
              await consumeResponseBody(response);
              if (!isSaveOperationCurrent(operation)) continue;
            }
            setSaveState("error");
            setDraftPending(true);
            toast(
              "Profile changes were not saved",
              "error",
              "Profile",
            );
            continue;
          }

          const result = await consumeResponseBody(response);
          if (!isSaveOperationCurrent(operation)) continue;
          if (!isProfileWriteSuccess(result, job.subject)) {
            captureCurrentSaveFailure(job, "profile_save_response");
            setSaveState("error");
            setDraftPending(true);
            toast(
              "Profile changes were not saved",
              "error",
              "Profile",
            );
            continue;
          }

          committedVersionsRef.current.set(
            job.subject,
            (committedVersionsRef.current.get(job.subject) ?? 0) + 1,
          );
          const committed = draftToProfile(
            job.subject,
            job.draft,
            profileRef.current?.email ?? null,
          );
          setCommittedProfile(committed);
          const committedDraft = profileToDraft(committed);
          draftRef.current = committedDraft;
          setDraft(committedDraft);
          dirtyRef.current = false;
          subjectDraftsRef.current.set(job.subject, {
            draft: committedDraft,
            dirty: false,
            generation: job.generation,
          });
          lastCapturedSaveFailureRef.current = null;
          setDraftPending(false);
          setSaveState("saved");
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
          savedTimerRef.current = setTimeout(() => {
            if (
              mountedRef.current &&
              subjectRef.current === job.subject &&
              !dirtyRef.current &&
              job.generation === generationRef.current
            ) {
              setSaveState("idle");
            }
          }, 2_000);
        } catch (error) {
          if (!isSaveOperationCurrent(operation) || isAbortError(error)) {
            continue;
          }
          captureCurrentSaveFailure(job, "profile_save_network");
          if (job.generation === generationRef.current) {
            setSaveState("error");
            setDraftPending(true);
            toast(
              "Profile changes were not saved",
              "error",
              "Profile",
            );
          }
        } finally {
          if (activeSaveRef.current === operation) {
            activeSaveRef.current = null;
          }
        }
      }
    } finally {
      if (drainingEpochRef.current === epoch) {
        drainingEpochRef.current = null;
      }
    }
  }, [
    captureCurrentSaveFailure,
    isSaveOperationCurrent,
    setCommittedProfile,
    setDraftPending,
    storeCurrentSubjectDraft,
    toast,
  ]);

  drainSaveQueueRef.current = drainSaveQueue;

  const scheduleProfileSave = useCallback(
    (nextDraft: ProfileDraft) => {
      const subject = subjectRef.current;
      if (!subject) {
        toast(
          "Sign in before editing your profile.",
          "error",
          "Profile",
        );
        return;
      }
      scheduleForSubject(subject, nextDraft);
    },
    [scheduleForSubject, toast],
  );

  const retryProfileSave = useCallback(() => {
    const subject = subjectRef.current;
    if (!subject || !dirtyRef.current) return;
    if (blockedReasonRef.current === "signed-out") {
      toast(
        "Sign in again before retrying these profile changes.",
        "error",
        "Profile",
      );
      return;
    }
    if (blockedReasonRef.current === "mfa-required") {
      toast(
        "Complete two-factor authentication before retrying.",
        "error",
        "Profile",
      );
      return;
    }
    if (blockedReasonRef.current) {
      setLookupNonce((value) => value + 1);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const epoch = saveEpochRef.current;
    queuedSaveRef.current = {
      subject,
      draft: draftRef.current,
      generation: generationRef.current,
      epoch,
    };
    setSaveState("pending");
    void drainSaveQueue();
  }, [drainSaveQueue, toast]);

  const beginAvatarOperation = useCallback(
    (
      expectedSubject: string,
      initialState: "processing" | "uploading",
    ) => {
      const subject = subjectRef.current;
      if (!subject) {
        toast("Sign in before uploading a profile photo.", "error", "Profile");
        return null;
      }
      if (subject !== expectedSubject) {
        toast(
          "The signed-in account changed. Select the photo again.",
          "error",
          "Profile",
        );
        return null;
      }
      if (blockedReasonRef.current === "mfa-required") {
        setUploadState("mfa-required");
        toast(
          "Complete two-factor authentication before uploading a photo.",
          "error",
          "Profile",
        );
        return null;
      }
      if (blockedReasonRef.current) {
        toast(
          "Sign in again before uploading a profile photo.",
          "error",
          "Profile",
        );
        return null;
      }

      const generation = ++uploadGenerationRef.current;
      const controller = new AbortController();
      activeAvatarRef.current?.controller.abort();
      const operation: ActiveAvatarOperation = {
        controller,
        subject,
        generation,
        identity: Symbol("profile-avatar-operation"),
      };
      activeAvatarRef.current = operation;
      setUploadState(initialState);
      setUploadPending(true);
      return operation;
    },
    [setUploadPending, toast],
  );

  const performAvatarUpload = useCallback(
    async (operation: ActiveAvatarOperation, file: File | Blob) => {
      try {
        const form = new FormData();
        form.append("file", file, "avatar.jpg");
        form.append("subject", operation.subject);
        const response = await fetch("/api/profile/avatar", {
          method: "POST",
          body: form,
          signal: operation.controller.signal,
        });
        if (!isAvatarOperationCurrent(operation)) return;

        if (response.status === 401) {
          blockedReasonRef.current = "signed-out";
          setCommittedProfile(null);
          setState("signed-out");
          setUploadState("error");
          toast(
            "Your session expired before the photo could be saved.",
            "error",
            "Profile",
          );
          return;
        }

        let bodyWasConsumed = false;
        if (response.status === 403) {
          const requiresMfa = await responseRequiresMfa(response);
          if (!isAvatarOperationCurrent(operation)) return;
          bodyWasConsumed = true;
          if (requiresMfa) {
            blockedReasonRef.current = "mfa-required";
            setState("mfa-required");
            setUploadState("mfa-required");
            toast(
              "Complete two-factor authentication to upload a profile photo.",
              "error",
              "Profile",
            );
            return;
          }
        }

        if (response.status === 409) {
          if (!bodyWasConsumed) {
            await consumeResponseBody(response);
            if (!isAvatarOperationCurrent(operation)) return;
          }
          blockedReasonRef.current = "subject-changed";
          setCommittedProfile(null);
          setState("loading");
          setUploadState("error");
          toast(
            "The signed-in account changed. The photo was not attached.",
            "error",
            "Profile",
          );
          setLookupNonce((value) => value + 1);
          return;
        }

        if (!response.ok) {
          if (!bodyWasConsumed) {
            await consumeResponseBody(response);
            if (!isAvatarOperationCurrent(operation)) return;
          }
          setUploadState("error");
          toast("Photo upload failed", "error", "Profile");
          return;
        }

        const result = await consumeResponseBody(response);
        if (!isAvatarOperationCurrent(operation)) return;
        if (!isAvatarUploadSuccess(result, operation.subject)) {
          if (
            lastCapturedUploadFailureRef.current !== operation.generation
          ) {
            lastCapturedUploadFailureRef.current = operation.generation;
            captureProfileClientFailure("profile_avatar_upload_response");
          }
          setUploadState("error");
          toast("Photo upload failed", "error", "Profile");
          return;
        }

        scheduleForSubject(operation.subject, {
          ...draftRef.current,
          photo: result.url,
        });
        setUploadState("idle");
      } catch (error) {
        if (!isAvatarOperationCurrent(operation) || isAbortError(error)) {
          return;
        }
        if (
          lastCapturedUploadFailureRef.current !== operation.generation
        ) {
          lastCapturedUploadFailureRef.current = operation.generation;
          captureProfileClientFailure("profile_avatar_upload_network");
        }
        setUploadState("error");
        toast("Photo upload failed", "error", "Profile");
      } finally {
        if (isAvatarOperationCurrent(operation)) {
          activeAvatarRef.current = null;
          setUploadPending(false);
        }
      }
    },
    [
      isAvatarOperationCurrent,
      scheduleForSubject,
      setCommittedProfile,
      setUploadPending,
      toast,
    ],
  );

  const uploadProfilePhoto = useCallback(
    async (file: File | Blob, expectedSubject: string) => {
      const operation = beginAvatarOperation(
        expectedSubject,
        "uploading",
      );
      if (!operation) return;
      await performAvatarUpload(operation, file);
    },
    [beginAvatarOperation, performAvatarUpload],
  );

  const processAndUploadProfilePhoto = useCallback(
    async (
      imageSrc: string,
      crop: Area,
      expectedSubject: string,
    ) => {
      const operation = beginAvatarOperation(
        expectedSubject,
        "processing",
      );
      if (!operation) return;
      try {
        const blob = await getCroppedImageBlob(imageSrc, crop);
        if (!isAvatarOperationCurrent(operation)) return;
        setUploadState("uploading");
        await performAvatarUpload(operation, blob);
        if (!isAvatarOperationCurrent(operation)) return;
      } catch (error) {
        if (!isAvatarOperationCurrent(operation) || isAbortError(error)) {
          return;
        }
        if (
          lastCapturedUploadFailureRef.current !== operation.generation
        ) {
          lastCapturedUploadFailureRef.current = operation.generation;
          captureProfileClientFailure("profile_avatar_crop");
        }
        setUploadState("error");
        toast("Could not crop photo", "error", "Profile");
      } finally {
        if (isAvatarOperationCurrent(operation)) {
          activeAvatarRef.current = null;
          setUploadPending(false);
        }
      }
    },
    [
      beginAvatarOperation,
      isAvatarOperationCurrent,
      performAvatarUpload,
      setUploadPending,
      toast,
    ],
  );

  const cancelProfilePhotoProcessing = useCallback(
    (expectedSubject: string) => {
      const operation = activeAvatarRef.current;
      if (!operation || operation.subject !== expectedSubject) return;
      uploadGenerationRef.current += 1;
      operation.controller.abort();
      activeAvatarRef.current = null;
      if (subjectRef.current === expectedSubject) {
        setUploadState("idle");
        setUploadPending(false);
      }
    },
    [setUploadPending],
  );

  useEffect(() => {
    mountedRef.current = true;
    pageActiveRef.current = true;
    const handlePageHide = () => {
      pageActiveRef.current = false;
      lookupGenerationRef.current += 1;
      activeLookupRef.current?.controller.abort();
      activeLookupRef.current = null;
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      pageActiveRef.current = true;
      if (event.persisted) setLookupNonce((current) => current + 1);
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      mountedRef.current = false;
      pageActiveRef.current = false;
      lookupGenerationRef.current += 1;
      activeLookupRef.current?.controller.abort();
      activeLookupRef.current = null;
      cancelSubjectWork(false);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [cancelSubjectWork]);

  useEffect(() => {
    const requestGeneration = ++lookupGenerationRef.current;
    const committedVersionsAtStart = new Map(committedVersionsRef.current);
    const controller = new AbortController();
    const operation: ActiveLookupOperation = {
      controller,
      generation: requestGeneration,
      subjectAtStart: subjectRef.current,
      identity: Symbol("shell-profile-lookup"),
    };
    activeLookupRef.current?.controller.abort();
    activeLookupRef.current = operation;
    if (!profileRef.current) setState("loading");

    void (async () => {
      try {
        const response = await fetch("/api/auth/profile", {
          signal: controller.signal,
        });
        if (!isLookupOperationCurrent(operation)) return;

        if (response.status === 401) {
          lookupFailureCapturedRef.current = false;
          blockedReasonRef.current = subjectRef.current
            ? "signed-out"
            : null;
          setCommittedProfile(null);
          setState("signed-out");
          if (dirtyRef.current) {
            setSaveState("session-expired");
            setDraftPending(true);
          }
          return;
        }

        let bodyWasConsumed = false;
        if (response.status === 403) {
          const requiresMfa = await responseRequiresMfa(response);
          if (!isLookupOperationCurrent(operation)) return;
          bodyWasConsumed = true;
          if (requiresMfa) {
            lookupFailureCapturedRef.current = false;
            blockedReasonRef.current = subjectRef.current
              ? "mfa-required"
              : null;
            setState("mfa-required");
            if (dirtyRef.current) {
              setSaveState("mfa-required");
              setDraftPending(true);
            }
            return;
          }
        }

        if (!response.ok) {
          if (!bodyWasConsumed) {
            await consumeResponseBody(response);
            if (!isLookupOperationCurrent(operation)) return;
          }
          setState("error");
          return;
        }

        const nextProfile = await consumeResponseBody(response);
        if (!isLookupOperationCurrent(operation)) return;
        if (!isShellProfile(nextProfile)) {
          throw new Error("Invalid shell profile");
        }
        lookupFailureCapturedRef.current = false;

        const previousSubject = subjectRef.current;
        const subjectChanged =
          previousSubject !== null &&
          previousSubject !== nextProfile.subject;
        const wasBlocked = blockedReasonRef.current !== null;

        if (subjectChanged) {
          const previousDraftWasDirty = dirtyRef.current;
          const previousUploadWasPending = uploadPendingRef.current;
          storeCurrentSubjectDraft();
          cancelSubjectWork();
          if (previousDraftWasDirty) {
            toast(
              "Unsaved profile changes were set aside for the previous account.",
              "error",
              "Profile",
            );
          }
          if (previousUploadWasPending) {
            toast(
              "The profile photo upload stopped because the signed-in account changed.",
              "error",
              "Profile",
            );
          }
        }

        subjectRef.current = nextProfile.subject;
        blockedReasonRef.current = null;
        setState("ready");
        setUploadState((current) =>
          current === "mfa-required" ? "idle" : current,
        );

        if (subjectChanged || previousSubject === null) {
          setCommittedProfile(nextProfile);
          const retained = subjectDraftsRef.current.get(nextProfile.subject);
          if (retained?.dirty) {
            draftRef.current = retained.draft;
            setDraft(retained.draft);
            dirtyRef.current = true;
            generationRef.current = retained.generation;
            setDraftPending(true);
            setSaveState("error");
          } else {
            const nextDraft = profileToDraft(nextProfile);
            draftRef.current = nextDraft;
            setDraft(nextDraft);
            dirtyRef.current = false;
            generationRef.current = retained?.generation ?? 0;
            subjectDraftsRef.current.set(nextProfile.subject, {
              draft: nextDraft,
              dirty: false,
              generation: generationRef.current,
            });
            setDraftPending(false);
            setSaveState("idle");
          }
          return;
        }

        const canHydrateFromLookup =
          (committedVersionsAtStart.get(nextProfile.subject) ?? 0) ===
          (committedVersionsRef.current.get(nextProfile.subject) ?? 0);
        if (canHydrateFromLookup) {
          setCommittedProfile(nextProfile);
        }
        if (canHydrateFromLookup && !dirtyRef.current) {
          const nextDraft = profileToDraft(nextProfile);
          draftRef.current = nextDraft;
          setDraft(nextDraft);
          subjectDraftsRef.current.set(nextProfile.subject, {
            draft: nextDraft,
            dirty: false,
            generation: generationRef.current,
          });
          setSaveState("idle");
          setDraftPending(false);
        } else if (wasBlocked) {
          setSaveState("error");
          setDraftPending(dirtyRef.current);
        }
      } catch (error) {
        if (!isLookupOperationCurrent(operation) || isAbortError(error)) {
          return;
        }
        await deferFailureCommit();
        if (!isLookupOperationCurrent(operation)) return;
        if (!lookupFailureCapturedRef.current) {
          lookupFailureCapturedRef.current = true;
          captureShellProfileFailure();
        }
        setState("error");
      }
    })();

    return () => {
      controller.abort();
      if (activeLookupRef.current === operation) {
        activeLookupRef.current = null;
      }
    };
  }, [
    cancelSubjectWork,
    isLookupOperationCurrent,
    lookupNonce,
    pathname,
    setCommittedProfile,
    setDraftPending,
    storeCurrentSubjectDraft,
    toast,
  ]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftPendingRef.current && !uploadPendingRef.current) return;
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
      uploadState,
      hasPendingChanges,
      scheduleProfileSave,
      retryProfileSave,
      uploadProfilePhoto,
      processAndUploadProfilePhoto,
      cancelProfilePhotoProcessing,
    }),
    [
      draft,
      cancelProfilePhotoProcessing,
      hasPendingChanges,
      processAndUploadProfilePhoto,
      profile,
      retryProfileSave,
      saveState,
      scheduleProfileSave,
      state,
      uploadProfilePhoto,
      uploadState,
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
