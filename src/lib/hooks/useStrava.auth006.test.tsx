// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "@/components/layout/ShellProfileContext";
import { useStrava, type StravaStatus } from "@/lib/hooks/useStrava";

const SUBJECT_A = `ps1_${"c".repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observedStatus: StravaStatus | null = null;

function Probe({ state, subject, epoch }: { state: AccountState; subject: string | null; epoch: number }) {
  const strava = useStrava("km", { accountState: state, subject, authorityEpoch: epoch });
  observedStatus = strava.status;
  return null;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  observedStatus = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useStrava AUTH-006 authority fencing", () => {
  it("aborts and discards an A status body after the shell retires A", async () => {
    const body = deferred<StravaStatus>();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve({ ok: true, status: 200, json: () => body.promise });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(<Probe state="loading" subject={null} epoch={2} />);
    });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      body.resolve({
        connected: true,
        configured: true,
        athlete: { name: "A athlete", avatar: "private" },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observedStatus).toBeNull();
  });
});
