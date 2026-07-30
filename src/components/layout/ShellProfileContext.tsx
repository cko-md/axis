"use client";

import * as Sentry from "@sentry/nextjs";
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type AccountState = "loading" | "signed-out" | "ready" | "error";

export type ShellProfile = {
  display_name: string | null;
  role_title: string | null;
  bio: string | null;
  avatar_url: string | null;
  email: string | null;
};

export type ShellProfileContextValue = {
  state: AccountState;
  profile: ShellProfile | null;
};

const PROFILE_KEYS = [
  "display_name",
  "role_title",
  "bio",
  "avatar_url",
  "email",
] as const;

const INITIAL_VALUE: ShellProfileContextValue = {
  state: "loading",
  profile: null,
};

export const ShellProfileContext =
  createContext<ShellProfileContextValue | null>(null);

function isShellProfile(value: unknown): value is ShellProfile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === PROFILE_KEYS.length &&
    PROFILE_KEYS.every(
      (key) => record[key] === null || typeof record[key] === "string",
    )
  );
}

function captureShellProfileFailure() {
  Sentry.captureException(new Error("Shell profile lookup failed"), {
    tags: {
      area: "navigation",
      operation: "shell_profile_lookup",
    },
  });
}

export function ShellProfileProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<ShellProfileContextValue>(INITIAL_VALUE);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/auth/profile", {
          signal: controller.signal,
        });
        if (!active) return;
        if (response.status === 401) {
          setValue({ state: "signed-out", profile: null });
          return;
        }
        if (!response.ok) {
          setValue({ state: "error", profile: null });
          return;
        }

        const profile: unknown = await response.json();
        if (!isShellProfile(profile)) throw new Error("Invalid shell profile");
        if (!active) return;
        setValue({ state: "ready", profile });
      } catch (error) {
        if (
          !active ||
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        captureShellProfileFailure();
        setValue({ state: "error", profile: null });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

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
