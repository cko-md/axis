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
let observedGeoStatus = "idle";

function Probe({ state, subject, epoch }: { state: AccountState; subject: string | null; epoch: number }) {
  const result = useWidgetData(WIDGET_IDS, false, {
    accountState: state,
    subject,
    authorityEpoch: epoch,
  });
  observed = result.data;
  observedGeoStatus = result.geoStatus;
  return null;
}

function LocationProbe({ state, subject, epoch }: { state: AccountState; subject: string | null; epoch: number }) {
  const result = useWidgetData(WIDGET_IDS, true, {
    accountState: state,
    subject,
    authorityEpoch: epoch,
  });
  observed = result.data;
  observedGeoStatus = result.geoStatus;
  return null;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const initialGeolocation = Object.getOwnPropertyDescriptor(navigator, "geolocation");

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  observed = {};
  observedGeoStatus = "idle";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (initialGeolocation) {
    Object.defineProperty(navigator, "geolocation", initialGeolocation);
  } else {
    Reflect.deleteProperty(navigator, "geolocation");
  }
});

describe("useWidgetData AUTH-006 subject boundary", () => {
  it("discards a delayed A batch body after the shell authority changes", async () => {
    const body = deferred<Record<string, unknown>>();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === "/api/widgets/cache") {
        return Promise.resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
      }
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
    expect(fetchMock).toHaveBeenCalledTimes(2);

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

  it("aborts an interval batch request when the hook unmounts", async () => {
    vi.useFakeTimers();
    const intervalBody = deferred<Record<string, unknown>>();
    let intervalSignal: AbortSignal | undefined;
    let batchCalls = 0;
    const fetchMock = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === "/api/widgets/cache") {
        return Promise.resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
      }
      batchCalls += 1;
      if (batchCalls === 2) {
        intervalSignal = init?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => intervalBody.promise,
        });
      }
      return Promise.resolve(new Response(JSON.stringify({
        widgets: {},
        errors: {},
        fetchedAt: new Date().toISOString(),
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(intervalSignal?.aborted).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    expect(intervalSignal?.aborted).toBe(true);

    intervalBody.resolve({
      widgets: {
        run: {
          id: "run",
          status: "ok",
          value: "private interval result",
          hint: "private interval hint",
          fetchedAt: new Date().toISOString(),
          source: "strava",
        },
      },
      errors: {},
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("paints subject-bound cache before the live batch and then commits fresh data", async () => {
    const liveBody = deferred<Record<string, unknown>>();
    const fetchMock = vi.fn((url: URL) => {
      if (url.pathname === "/api/widgets/cache") {
        return Promise.resolve(new Response(JSON.stringify({
          rows: [{
            widget_id: "run",
            cache_key: "run",
            status: "fresh",
            value: "cached run",
            hint: "cached hint",
            raw: {},
            error: null,
            fetched_at: "2026-08-09T00:00:00.000Z",
            expires_at: "2099-08-09T00:15:00.000Z",
          }],
        }), { status: 200 }));
      }
      return Promise.resolve({ ok: true, status: 200, json: () => liveBody.promise });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.run?.v).toBe("cached run");
    expect(observed.run?.loading).toBe(true);

    await act(async () => {
      liveBody.resolve({
        widgets: {
          run: {
            id: "run",
            status: "fresh",
            value: "fresh run",
            hint: "fresh hint",
            fetchedAt: "2026-08-09T00:01:00.000Z",
            source: { provider: "strava", cacheKey: "run" },
          },
        },
        errors: {},
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.run?.v).toBe("fresh run");
    expect(observed.run?.loading).toBe(false);
  });

  it("does not let a late cache body overwrite a committed live widget", async () => {
    const cacheBody = deferred<Record<string, unknown>>();
    const fetchMock = vi.fn((url: URL) => {
      if (url.pathname === "/api/widgets/cache") {
        return Promise.resolve({ ok: true, status: 200, json: () => cacheBody.promise });
      }
      return Promise.resolve(new Response(JSON.stringify({
        widgets: {
          run: {
            id: "run",
            status: "fresh",
            value: "fresh wins",
            hint: "fresh hint",
            fetchedAt: "2026-08-09T00:01:00.000Z",
            source: { provider: "strava", cacheKey: "run" },
          },
        },
        errors: {},
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.run?.v).toBe("fresh wins");

    await act(async () => {
      cacheBody.resolve({
        rows: [{
          widget_id: "run",
          cache_key: "run",
          status: "fresh",
          value: "late cache",
          hint: "late cache hint",
          raw: {},
          error: null,
          fetched_at: "2099-08-09T00:00:00.000Z",
          expires_at: "2099-08-09T00:15:00.000Z",
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.run?.v).toBe("fresh wins");
  });

  it("aborts and discards a delayed cache body when authority retires", async () => {
    const cacheBody = deferred<Record<string, unknown>>();
    let cacheSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === "/api/widgets/cache") {
        cacheSignal = init?.signal ?? undefined;
        return Promise.resolve({ ok: true, status: 200, json: () => cacheBody.promise });
      }
      return Promise.resolve(new Response(JSON.stringify({
        widgets: {},
        errors: {},
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(<Probe state="loading" subject={null} epoch={2} />);
    });
    expect(cacheSignal?.aborted).toBe(true);

    await act(async () => {
      cacheBody.resolve({
        rows: [{
          widget_id: "run",
          cache_key: "run",
          status: "fresh",
          value: "retired private cache",
          hint: "retired private hint",
          raw: {},
          error: null,
          fetched_at: "2099-08-09T00:00:00.000Z",
          expires_at: "2099-08-09T00:15:00.000Z",
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed).toEqual({});
  });

  it.each([
    ["non-array rows", { ok: true, status: 200, json: () => Promise.resolve({ rows: {} }) }],
    ["null row", { ok: true, status: 200, json: () => Promise.resolve({ rows: [null] }) }],
    ["rejected JSON", { ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) }],
    ["cache 502", { ok: false, status: 502, json: () => Promise.resolve({ error: "unavailable" }) }],
  ])("keeps live data authoritative for a malformed %s cache response", async (_case, cacheResponse) => {
    const fetchMock = vi.fn((url: URL) => {
      if (url.pathname === "/api/widgets/cache") return Promise.resolve(cacheResponse);
      return Promise.resolve(new Response(JSON.stringify({
        widgets: {
          run: {
            id: "run",
            status: "fresh",
            value: "live remains authoritative",
            hint: "live hint",
            fetchedAt: "2026-08-09T00:01:00.000Z",
            source: { provider: "strava", cacheKey: "run" },
          },
        },
        errors: {},
      }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Probe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.run?.v).toBe("live remains authoritative");
  });

  it("keeps cache hydration alive when geolocation restarts only the live batch", async () => {
    const cacheBody = deferred<Record<string, unknown>>();
    const liveBodies: Array<ReturnType<typeof deferred<Record<string, unknown>>>> = [];
    const liveSignals: AbortSignal[] = [];
    let cacheSignal: AbortSignal | undefined;
    let succeed: PositionCallback | undefined;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (onSuccess: PositionCallback) => {
          succeed = onSuccess;
        },
      },
    });
    const fetchMock = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === "/api/widgets/cache") {
        cacheSignal = init?.signal ?? undefined;
        return Promise.resolve({ ok: true, status: 200, json: () => cacheBody.promise });
      }
      const body = deferred<Record<string, unknown>>();
      liveBodies.push(body);
      if (init?.signal) liveSignals.push(init.signal);
      return Promise.resolve({ ok: true, status: 200, json: () => body.promise });
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<LocationProbe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(liveBodies).toHaveLength(1);
    expect(cacheSignal?.aborted).toBe(false);

    await act(async () => {
      succeed?.({ coords: { latitude: 1, longitude: 2 } } as GeolocationPosition);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(liveSignals[0]?.aborted).toBe(true);
    expect(liveBodies).toHaveLength(2);
    expect(cacheSignal?.aborted).toBe(false);

    await act(async () => {
      cacheBody.resolve({
        rows: [{
          widget_id: "run",
          cache_key: "run",
          status: "fresh",
          value: "cache survives location",
          hint: "cached hint",
          raw: {},
          error: null,
          fetched_at: "2026-08-09T00:00:00.000Z",
          expires_at: "2099-08-09T00:15:00.000Z",
        }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observed.run?.v).toBe("cache survives location");
  });

  it("ignores a geolocation callback delivered after unmount", async () => {
    let succeed: PositionCallback | undefined;
    let fail: PositionErrorCallback | undefined;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          onSuccess: PositionCallback,
          onError: PositionErrorCallback,
        ) => {
          succeed = onSuccess;
          fail = onError;
        },
      },
    });
    const fetchMock = vi.fn((url: URL) => Promise.resolve(new Response(JSON.stringify(
      url.pathname === "/api/widgets/cache"
        ? { rows: [] }
        : { widgets: {}, errors: {} },
    ), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<LocationProbe state="ready" subject={SUBJECT_A} epoch={1} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(observedGeoStatus).toBe("pending");
    await act(async () => root?.unmount());
    root = null;
    const coordsRead = vi.fn();
    const codeRead = vi.fn();
    await act(async () => {
      succeed?.({
        get coords() {
          coordsRead();
          throw new Error("retired success payload was read");
        },
      } as unknown as GeolocationPosition);
      fail?.({
        get code() {
          codeRead();
          throw new Error("retired error payload was read");
        },
      } as unknown as GeolocationPositionError);
      await Promise.resolve();
    });
    expect(coordsRead).not.toHaveBeenCalled();
    expect(codeRead).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
