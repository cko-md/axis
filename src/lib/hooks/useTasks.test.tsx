// @vitest-environment jsdom

import React, { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  from: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.capture }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("./useRealtimeRefresh", () => ({ useRealtimeRefresh: vi.fn() }));

import { useTasks, type Task } from "./useTasks";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadBuilder(result: Promise<{ data: Task[] | null; error: unknown }>) {
  const signals: AbortSignal[] = [];
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.abortSignal = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return result;
  });
  return { builder, signals };
}

const user = { id: "task-owner" };
const task = (id: string): Task => ({
  id,
  user_id: user.id,
  title: `Task ${id}`,
  priority: "med",
  effort: null,
  deadline: null,
  category: "personal",
  status: "open",
  sort_order: 0,
  metadata: {},
  created_at: "2026-08-06T00:00:00.000Z",
  updated_at: "2026-08-06T00:00:00.000Z",
  completed_at: null,
});

let root: Root | null;
let latest: ReturnType<typeof useTasks> | null;

function Probe() {
  latest = useTasks();
  return <output>{latest.error?.message ?? latest.tasks.map((item) => item.id).join(",")}</output>;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushFailureCommit() {
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
}

function persistedPageShow() {
  const event = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: true });
  return event;
}

beforeEach(() => {
  mocks.capture.mockReset();
  mocks.from.mockReset();
  mocks.getUser.mockReset();
  latest = null;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("useTasks load lifecycle", () => {
  it("aborts and consumes the same load failure when pagehide invalidates the operation", async () => {
    const pending = deferred<{ data: Task[] | null; error: unknown }>();
    const load = loadBuilder(pending.promise);
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    expect(load.signals).toHaveLength(1);

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(load.signals[0].aborted).toBe(true);
    pending.reject(new TypeError("same live-looking failure"));
    await act(flushFailureCommit);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(latest?.error).toBeNull();
  });

  it("restarts an aborted load after an ordinary pageshow", async () => {
    const pending = deferred<{ data: Task[] | null; error: unknown }>();
    const interrupted = loadBuilder(pending.promise);
    const restored = loadBuilder(Promise.resolve({ data: [task("restored")], error: null }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValueOnce(interrupted.builder).mockReturnValueOnce(restored.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    expect(interrupted.signals).toHaveLength(1);

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(interrupted.signals[0].aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushFailureCommit);

    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["restored"]);
    expect(latest?.loading).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("finishes an ordinary pageshow recovery with a visible load failure", async () => {
    const pending = deferred<{ data: Task[] | null; error: unknown }>();
    const interrupted = loadBuilder(pending.promise);
    const failed = loadBuilder(Promise.resolve({ data: null, error: { code: "network", status: 503 } }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValueOnce(interrupted.builder).mockReturnValueOnce(failed.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushFailureCommit);

    expect(latest?.loading).toBe(false);
    expect(latest?.error?.message).toBe("Could not load tasks — check your connection and retry.");
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    pending.resolve({ data: [task("stale")], error: null });
    await act(flushFailureCommit);
    expect(latest?.tasks).toEqual([]);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("keeps the identical current load failure visible and captures it once", async () => {
    const sameError = new TypeError("same live-looking failure");
    const load = loadBuilder(Promise.reject(sameError));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flushFailureCommit);

    expect(latest?.error).toMatchObject({
      operation: "load",
      message: "Could not load tasks — check your connection and retry.",
    });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("drops a failure that resolves just before pagehide but has not committed", async () => {
    vi.useFakeTimers();
    const load = loadBuilder(Promise.reject(new TypeError("same live-looking failure")));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => vi.runOnlyPendingTimers());
    await act(flush);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(latest?.error).toBeNull();
  });

  it("lets a newer refresh win and aborts the stale request", async () => {
    const firstPending = deferred<{ data: Task[] | null; error: unknown }>();
    const first = loadBuilder(firstPending.promise);
    const second = loadBuilder(Promise.resolve({ data: [task("new")], error: null }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValueOnce(first.builder).mockReturnValueOnce(second.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    await act(async () => { await latest?.refresh(); });

    expect(first.signals[0].aborted).toBe(true);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["new"]);

    firstPending.reject(new TypeError("stale failure"));
    await act(flushFailureCommit);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["new"]);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("retains last-known rows when a background refresh fails", async () => {
    const initial = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const failed = loadBuilder(Promise.resolve({ data: null, error: { code: "network", status: 503 } }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValueOnce(initial.builder).mockReturnValueOnce(failed.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["known"]);

    await act(async () => { await latest?.refresh(); });

    expect(latest?.tasks.map((item) => item.id)).toEqual(["known"]);
    expect(latest?.error?.message).toBe("Could not load tasks — check your connection and retry.");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("does not retain another owner's rows when the authenticated subject changes", async () => {
    const nextUser = { id: "task-owner-2" };
    const initial = loadBuilder(Promise.resolve({ data: [task("owner-one")], error: null }));
    const failed = loadBuilder(Promise.resolve({ data: null, error: { code: "network", status: 503 } }));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockResolvedValueOnce({ data: { user: nextUser }, error: null });
    mocks.from.mockReturnValueOnce(initial.builder).mockReturnValueOnce(failed.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["owner-one"]);

    await act(async () => { await latest?.refresh(); });

    expect(latest?.tasks).toEqual([]);
    expect(latest?.error?.message).toBe("Could not load tasks — check your connection and retry.");
  });

  it.each([
    ["succeeds", { data: [task("owner-two")], error: null }, ["owner-two"]],
    ["fails", { data: null, error: { code: "network", status: 503 } }, []],
  ])("quarantines pre-BFCache rows before a restored cross-owner load %s", async (_case, restoredResult, expectedIds) => {
    const nextUser = { id: "task-owner-2" };
    const initial = loadBuilder(Promise.resolve({ data: [task("owner-one")], error: null }));
    const restored = loadBuilder(Promise.resolve(restoredResult));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockResolvedValueOnce({ data: { user: nextUser }, error: null });
    mocks.from.mockReturnValueOnce(initial.builder).mockReturnValueOnce(restored.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["owner-one"]);

    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(persistedPageShow()));
    expect(latest?.tasks).toEqual([]);
    await act(flushFailureCommit);

    expect(latest?.tasks.map((item) => item.id)).toEqual(expectedIds);
  });

  it("discards the unabortable StrictMode auth result from the retired mount", async () => {
    const firstAuth = deferred<{ data: { user: typeof user | null }; error: unknown }>();
    const load = loadBuilder(Promise.resolve({ data: [task("strict")], error: null }));
    mocks.getUser
      .mockReturnValueOnce(firstAuth.promise)
      .mockResolvedValueOnce({ data: { user }, error: null });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<StrictMode><Probe /></StrictMode>));
    await act(flush);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["strict"]);

    firstAuth.resolve({ data: { user }, error: null });
    await act(flushFailureCommit);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["strict"]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
});
