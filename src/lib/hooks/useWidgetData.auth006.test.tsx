// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "@/components/layout/ShellProfileContext";
import { useWidgetData, type WidgetData } from "@/lib/hooks/useWidgetData";

const SUBJECT_A = `ps1_${"d".repeat(64)}`;
const WIDGET_IDS = ["run"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observed: Record<string, WidgetData> = {};

function Probe({ state, subject, epoch }: { state: AccountState; subject: string | null; epoch: number }) {
  observed = useWidgetData(WIDGET_IDS, false, {
    accountState: state,
    subject,
    authorityEpoch: epoch,
  }).data;
  return null;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  observed = {};
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useWidgetData AUTH-006 subject boundary", () => {
  it("discards a delayed A batch body after the shell authority changes", async () => {
    const body = deferred<Record<string, unknown>>();
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
        widgets: {
          run: {
            id: "run",
            status: "ok",
            value: "A private training",
            hint: "A private hint",
            fetchedAt: new Date().toISOString(),
            source: "strava",
          },
        },
        errors: {},
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed).toEqual({});
  });
});
