// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authCallback: null as null | ((event: string) => void),
  unsubscribe: vi.fn(),
  capture: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.capture }));
vi.mock("next/navigation", () => ({ usePathname: () => "/command" }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/nav/cropImage", () => ({ getCroppedImageBlob: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (callback: (event: string) => void) => {
        mocks.authCallback = callback;
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
      },
    },
  }),
}));

import {
  ShellProfileProvider,
  useShellProfile,
  type ShellProfileContextValue,
} from "@/components/layout/ShellProfileContext";

const SUBJECT_A = `ps1_${"e".repeat(64)}`;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observed: ShellProfileContextValue | null = null;

function Probe() {
  observed = useShellProfile();
  return null;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const response = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn().mockResolvedValue(body),
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  observed = null;
  mocks.authCallback = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ShellProfileProvider AUTH-006 invalidation", () => {
  it("quarantines provider authority immediately on a Supabase auth event", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        subject: SUBJECT_A,
        display_name: "A",
        role_title: null,
        bio: null,
        avatar_url: null,
        email: null,
      }))
      .mockReturnValueOnce(new Promise(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ShellProfileProvider><Probe /></ShellProfileProvider>);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed?.state).toBe("ready");
    expect(observed?.profile?.subject).toBe(SUBJECT_A);
    const epoch = observed?.authorityEpoch ?? 0;

    await act(async () => {
      mocks.authCallback?.("SIGNED_OUT");
      await Promise.resolve();
    });
    expect(observed?.state).toBe("loading");
    expect(observed?.profile).toBeNull();
    expect(observed?.authorityEpoch).toBe(epoch + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
