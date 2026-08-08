// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;
const mocks = vi.hoisted(() => ({
  authority: {
    state: "ready",
    profile: { subject: `ps1_${"a".repeat(64)}` },
    authorityEpoch: 1,
  } as {
    state: "ready" | "loading";
    profile: { subject: string } | null;
    authorityEpoch: number;
  },
  toast: vi.fn(),
  playUris: vi.fn(),
  playContext: vi.fn(),
  disconnect: vi.fn(),
  queue: vi.fn(),
}));

vi.mock("@/components/layout/ShellProfileContext", () => ({
  useShellProfile: () => mocks.authority,
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ open, children, title }: { open: boolean; children: React.ReactNode; title: string }) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));
vi.mock("@/lib/ai/callAction", () => ({ callAiAction: vi.fn() }));
vi.mock("@/components/spotify/SpotifyProvider", () => ({
  useSpotify: () => ({
    connected: true,
    configured: true,
    connectError: null,
    now: {
      track: null,
      artist: "",
      album: "",
      art: null,
      durationMs: 0,
      progressMs: 0,
      device: null,
      volume: 50,
      shuffle: false,
      repeat: "off",
    },
    liveProgressMs: 0,
    playing: false,
    refresh: vi.fn(),
    connect: vi.fn(),
    disconnect: mocks.disconnect,
    togglePlay: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    playUris: mocks.playUris,
    playContext: mocks.playContext,
    queue: mocks.queue,
    sdkDeviceId: null,
  }),
}));

import { VaultModule } from "@/components/vault/VaultModule";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  mocks.authority = {
    state: "ready",
    profile: { subject: SUBJECT_A },
    authorityEpoch: 1,
  };
  mocks.playUris.mockReset();
  mocks.playContext.mockReset();
  mocks.disconnect.mockReset();
  mocks.queue.mockReset();
  mocks.toast.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Vault AUTH-006 stale operation retirement", () => {
  it("suppresses an aborted A search rejection after authority changes to B", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let searchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/api/spotify/search") {
        searchSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          searchSignal?.addEventListener("abort", () => {
            reject(new DOMException("Retired", "AbortError"));
          }, { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ connected: true, items: [] }), {
        status: 200,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<VaultModule />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const searchButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Search + Queue"));
    expect(searchButton).toBeDefined();
    await act(async () => searchButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>('input[placeholder="Search tracks…"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "A private query");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(searchSignal).toBeDefined();

    mocks.authority = {
      state: "ready",
      profile: { subject: SUBJECT_B },
      authorityEpoch: 2,
    };
    await act(async () => {
      root?.render(<VaultModule />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(searchSignal?.aborted).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalledWith(
      "Search failed.",
      "error",
      "Vault",
    );
    expect(container.textContent).not.toContain("A private query");
  });

  it("suppresses A-owned playback success feedback after authority changes to B", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const playback = deferred<{
      ok: boolean;
      subject: string;
      epoch: number;
    }>();
    mocks.playUris.mockReturnValue(playback.promise);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString(), window.location.origin);
      const subject = new Headers(init?.headers).get("x-axis-expected-profile-subject");
      const items = subject === SUBJECT_A && url.searchParams.get("kind") === "recent"
        ? [{
            id: "track-a",
            uri: "spotify:track:a",
            name: "A private track",
            artists: "A private artist",
            album: "A private album",
            art: null,
            durationMs: 100,
          }]
        : [];
      return Promise.resolve(new Response(JSON.stringify({ connected: true, items }), {
        status: 200,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<VaultModule />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const privateTrack = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("A private track"));
    expect(privateTrack).toBeDefined();
    await act(async () => {
      privateTrack?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.playUris).toHaveBeenCalledWith(["spotify:track:a"]);

    mocks.authority = {
      state: "ready",
      profile: { subject: SUBJECT_B },
      authorityEpoch: 2,
    };
    await act(async () => {
      root?.render(<VaultModule />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      playback.resolve({ ok: true, subject: SUBJECT_A, epoch: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toast).not.toHaveBeenCalledWith(
      "Playing A private track",
      "success",
      "Vault",
    );
  });

  it("surfaces a current provider playback failure without leaking stale feedback", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    mocks.playUris.mockResolvedValue({
      ok: false,
      subject: SUBJECT_A,
      epoch: 1,
      message: "Open Spotify on a device first.",
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      const items = url.searchParams.get("kind") === "recent"
        ? [{
            id: "track-a",
            uri: "spotify:track:a",
            name: "A private track",
            artists: "A private artist",
            album: "A private album",
            art: null,
            durationMs: 100,
          }]
        : [];
      return Promise.resolve(new Response(JSON.stringify({ connected: true, items }), {
        status: 200,
      }));
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<VaultModule />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const privateTrack = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("A private track"));
    expect(privateTrack).toBeDefined();
    await act(async () => {
      privateTrack?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toast).toHaveBeenCalledWith(
      "Open Spotify on a device first.",
      "warn",
      "Vault",
    );
    expect(mocks.toast).not.toHaveBeenCalledWith(
      "Playing A private track",
      "success",
      "Vault",
    );
  });
});
