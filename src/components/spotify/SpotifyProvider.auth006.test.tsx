// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SpotifyProvider,
  useSpotify,
  type NowPlaying,
} from "@/components/spotify/SpotifyProvider";

const SUBJECT_A = `ps1_${"a".repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observed: { connected: boolean; track: string; now: NowPlaying } | null = null;

function Probe() {
  const spotify = useSpotify();
  observed = { connected: spotify.connected, track: spotify.track, now: spotify.now };
  return null;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  observed = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SpotifyProvider AUTH-006 authority fencing", () => {
  it("aborts an A poll and discards a body that resolves after authority retires", async () => {
    const body = deferred<Record<string, unknown>>();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => body.promise,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SpotifyProvider accountState="ready" subject={SUBJECT_A} authorityEpoch={1}>
          <Probe />
        </SpotifyProvider>,
      );
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(
        <SpotifyProvider accountState="loading" subject={null} authorityEpoch={2}>
          <Probe />
        </SpotifyProvider>,
      );
    });
    expect(capturedSignal?.aborted).toBe(true);

    await act(async () => {
      body.resolve({
        connected: true,
        configured: true,
        playing: true,
        track: "A private track",
        artist: "A private artist",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observed?.connected).toBe(false);
    expect(observed?.track).toBe("Not playing");
    expect(observed?.now.track).toBeNull();
  });
});
