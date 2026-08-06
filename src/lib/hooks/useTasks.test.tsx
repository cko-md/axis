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

function mutationBuilder(result: () => Promise<{ data: Task | null; error: unknown }>) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.insert = vi.fn(() => builder);
  builder.update = vi.fn(() => builder);
  builder.delete = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.select = vi.fn(() => builder);
  builder.single = vi.fn(() => result());
  builder.then = vi.fn((resolve, reject) => result().then(resolve, reject));
  return builder;
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
  it("ignores an unpaired pageshow without duplicating the initial load", async () => {
    const load = loadBuilder(Promise.resolve({ data: [task("initial")], error: null }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flush);

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(latest?.tasks.map((item) => item.id)).toEqual(["initial"]);
  });

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

  it.each([
    { status: 401, message: "session no longer available" },
    { name: "AuthSessionMissingError", status: 400 },
    { code: "invalid_refresh_token", status: 400 },
    { message: "Auth session missing!", status: 400 },
  ])("treats an exact expected auth transition as signed out without capture", async (authError) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: authError });

    act(() => root?.render(<Probe />));
    await act(flushFailureCommit);

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.tasks).toEqual([]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("treats a thrown exact missing session as signed out without capture", async () => {
    mocks.getUser.mockRejectedValue({ message: "Auth session missing!" });

    act(() => root?.render(<Probe />));
    await act(flushFailureCommit);

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.tasks).toEqual([]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("keeps a thrown AuthSessionMissingError-shaped 500 load actionable", async () => {
    mocks.getUser.mockRejectedValue({
      name: "AuthSessionMissingError",
      status: 500,
      message: "upstream auth failure",
    });

    act(() => root?.render(<Probe />));
    await act(flushFailureCommit);

    expect(latest?.loading).toBe(false);
    expect(latest?.error?.message).toBe(
      "Could not load tasks — check your connection and retry.",
    );
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("keeps an AuthSessionMissingError-shaped 500 actionable", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthSessionMissingError",
        status: 500,
        message: "upstream auth failure",
      },
    });

    act(() => root?.render(<Probe />));
    await act(flushFailureCommit);

    expect(latest?.loading).toBe(false);
    expect(latest?.error?.message).toBe(
      "Could not load tasks — sign in again and retry.",
    );
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
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

  it.each(["resolves", "rejects"] as const)(
    "retires a prior-owner load before a signed-out mutation, even when the stale load %s",
    async (outcome) => {
      const pending = deferred<{ data: Task[] | null; error: unknown }>();
      const load = loadBuilder(pending.promise);
      mocks.getUser
        .mockResolvedValueOnce({ data: { user }, error: null })
        .mockResolvedValueOnce({
          data: { user: null },
          error: { status: 401, message: "session expired" },
        });
      mocks.from.mockReturnValue(load.builder);

      act(() => root?.render(<Probe />));
      await act(flush);
      expect(load.signals).toHaveLength(1);

      let result: Task | null | undefined;
      await act(async () => {
        result = await latest?.addTask({ title: "New", category: "personal" });
      });

      expect(result).toBeNull();
      expect(load.signals[0].aborted).toBe(true);
      expect(latest?.loading).toBe(false);
      expect(latest?.tasks).toEqual([]);
      expect(latest?.error).toEqual({
        operation: "add",
        message: "Sign in to create tasks.",
      });

      if (outcome === "resolves") {
        pending.resolve({ data: [task("prior-owner")], error: null });
      } else {
        pending.reject(new TypeError("stale prior-owner load failure"));
      }
      await act(flushFailureCommit);

      expect(latest?.loading).toBe(false);
      expect(latest?.tasks).toEqual([]);
      expect(latest?.error).toEqual({
        operation: "add",
        message: "Sign in to create tasks.",
      });
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.from).toHaveBeenCalledTimes(1);
    },
  );

  describe.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), null],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), null],
    ["delete", async () => latest?.deleteTask("known"), false],
    ["toggle", async () => latest?.toggleDone("known"), null],
  ] as const)("%s ownership epoch", (_operation, invoke, neutralResult) => {
    it.each([
      ["returned", "resolves"],
      ["returned", "rejects"],
      ["thrown", "resolves"],
      ["thrown", "rejects"],
    ] as const)(
      "makes an older mutation neutral when a newer %s missing session settles and the older request %s",
      async (sessionOutcome, mutationOutcome) => {
        const pending = deferred<{ data: Task | null; error: unknown }>();
        const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
        const mutation = mutationBuilder(() => pending.promise);
        mocks.getUser
          .mockResolvedValueOnce({ data: { user }, error: null })
          .mockResolvedValueOnce({ data: { user }, error: null });
        if (sessionOutcome === "returned") {
          mocks.getUser.mockResolvedValueOnce({
            data: { user: null },
            error: { status: 401, message: "session expired" },
          });
        } else {
          mocks.getUser.mockRejectedValueOnce({
            message: "Auth session missing!",
            status: 400,
          });
        }
        mocks.from
          .mockReturnValueOnce(load.builder)
          .mockReturnValueOnce(mutation);

        act(() => root?.render(<Probe />));
        await act(flush);

        let older!: Promise<unknown>;
        act(() => { older = Promise.resolve(invoke()); });
        await act(flush);
        expect(mocks.from).toHaveBeenCalledTimes(2);

        let newerResult: unknown;
        await act(async () => { newerResult = await invoke(); });
        expect(newerResult).toBe(neutralResult);
        expect(latest?.tasks).toEqual([]);
        const signedOutError = latest?.error;
        expect(signedOutError?.message).toMatch(/^Sign in to /);

        if (mutationOutcome === "resolves") {
          pending.resolve({ data: task("older-success"), error: null });
        } else {
          pending.reject({
            name: "AuthSessionMissingError",
            status: 500,
            message: "older actionable failure",
          });
        }
        let olderResult: unknown;
        await act(async () => { olderResult = await older; });

        expect(olderResult).toBe(neutralResult);
        expect(latest?.tasks).toEqual([]);
        expect(latest?.error).toEqual(signedOutError);
        expect(mocks.capture).not.toHaveBeenCalled();
        expect(mocks.from).toHaveBeenCalledTimes(2);
      },
    );
  });

  describe.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), null, "add"],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), null, "update"],
    ["delete", async () => latest?.deleteTask("known"), false, "delete"],
    ["toggle", async () => latest?.toggleDone("known"), null, "update"],
  ] as const)("%s subject binding", (_operation, invoke, neutralResult, expectedErrorOperation) => {
    it("does not write or append across owners when displayed owner A authenticates as B", async () => {
      const ownerB = { id: "task-owner-b" };
      const taskB = { ...task("owner-b"), user_id: ownerB.id };
      const loadA = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
      const loadB = loadBuilder(Promise.resolve({ data: [taskB], error: null }));
      mocks.getUser
        .mockResolvedValueOnce({ data: { user }, error: null })
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
      mocks.from
        .mockReturnValueOnce(loadA.builder)
        .mockReturnValueOnce(loadB.builder);

      act(() => root?.render(<Probe />));
      await act(flush);

      let result: unknown;
      await act(async () => { result = await invoke(); });
      await act(flush);

      expect(result).toBe(neutralResult);
      expect(mocks.from).toHaveBeenCalledTimes(2);
      expect(latest?.tasks).toEqual([taskB]);
      expect(latest?.error).toEqual({
        operation: expectedErrorOperation,
        message: "Account changed — tasks reloaded for the current account. Retry your action.",
      });
      expect(mocks.capture).not.toHaveBeenCalled();
    });
  });

  describe.each(["add", "update", "delete", "toggle"] as const)(
    "%s during account-change recovery",
    (operation) => {
      it("stays neutral until the recovery snapshot settles, then permits a successful retry", async () => {
        const ownerB = { id: "task-owner-b" };
        const taskB = { ...task("known"), user_id: ownerB.id };
        const retryTask = {
          ...task(operation === "add" ? "new-b" : "known"),
          user_id: ownerB.id,
          title: operation === "update" ? "Changed" : taskB.title,
          status: operation === "toggle" ? "done" as const : taskB.status,
          completed_at: operation === "toggle" ? "2026-08-06T01:00:00.000Z" : null,
        };
        const recoveryPending = deferred<{ data: Task[] | null; error: unknown }>();
        const loadA = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
        const loadB = loadBuilder(recoveryPending.promise);
        const retryMutation = mutationBuilder(() => Promise.resolve({
          data: operation === "delete" ? null : retryTask,
          error: null,
        }));
        mocks.getUser
          .mockResolvedValueOnce({ data: { user }, error: null })
          .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
          .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
          .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
        mocks.from
          .mockReturnValueOnce(loadA.builder)
          .mockReturnValueOnce(loadB.builder)
          .mockReturnValueOnce(retryMutation);

        const invoke = () => {
          if (operation === "add") {
            return latest?.addTask({ title: "New", category: "personal" });
          }
          if (operation === "update") {
            return latest?.updateTask("known", { title: "Changed" });
          }
          if (operation === "delete") return latest?.deleteTask("known");
          return latest?.toggleDone("known");
        };
        const neutralResult = operation === "delete" ? false : null;

        act(() => root?.render(<Probe />));
        await act(flush);
        let mismatchResult: unknown;
        await act(async () => { mismatchResult = await invoke(); });

        expect(mismatchResult).toBe(neutralResult);
        expect(latest?.tasks).toEqual([]);
        expect(latest?.loading).toBe(true);
        expect(mocks.getUser).toHaveBeenCalledTimes(3);
        expect(mocks.from).toHaveBeenCalledTimes(2);

        let blockedRetryResult: unknown;
        await act(async () => { blockedRetryResult = await invoke(); });

        expect(blockedRetryResult).toBe(neutralResult);
        expect(mocks.getUser).toHaveBeenCalledTimes(3);
        expect(mocks.from).toHaveBeenCalledTimes(2);

        recoveryPending.resolve({ data: [taskB], error: null });
        await act(flush);

        expect(latest?.tasks).toEqual([taskB]);
        expect(latest?.error?.message).toBe(
          "Account changed — tasks reloaded for the current account. Retry your action.",
        );

        let successfulRetryResult: unknown;
        await act(async () => { successfulRetryResult = await invoke(); });

        if (operation === "delete") {
          expect(successfulRetryResult).toBe(true);
          expect(latest?.tasks).toEqual([]);
        } else {
          expect(successfulRetryResult).toEqual(retryTask);
          expect(latest?.tasks).toContainEqual(retryTask);
        }
        expect(latest?.error).toBeNull();
        expect(mocks.getUser).toHaveBeenCalledTimes(4);
        expect(mocks.from).toHaveBeenCalledTimes(3);
        expect(mocks.capture).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["returns-error", "throws"] as const)(
    "permits retry after an account-change recovery load %s",
    async (outcome) => {
      const ownerB = { id: "task-owner-b" };
      const retryTask = { ...task("new-b"), user_id: ownerB.id };
      const loadA = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
      const recoveryPending = deferred<{ data: Task[] | null; error: unknown }>();
      const loadB = loadBuilder(recoveryPending.promise);
      const retryMutation = mutationBuilder(() => Promise.resolve({
        data: retryTask,
        error: null,
      }));
      mocks.getUser
        .mockResolvedValueOnce({ data: { user }, error: null })
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
      mocks.from
        .mockReturnValueOnce(loadA.builder)
        .mockReturnValueOnce(loadB.builder)
        .mockReturnValueOnce(retryMutation);

      act(() => root?.render(<Probe />));
      await act(flush);
      let mismatchResult: Task | null | undefined;
      await act(async () => {
        mismatchResult = await latest?.addTask({ title: "Mismatch", category: "personal" });
      });
      if (outcome === "returns-error") {
        recoveryPending.resolve({
          data: null,
          error: { status: 503, message: "temporary recovery failure" },
        });
      } else {
        recoveryPending.reject({ status: 503, message: "thrown recovery failure" });
      }
      await act(flushFailureCommit);

      expect(mismatchResult).toBeNull();
      expect(latest?.tasks).toEqual([]);
      expect(latest?.error?.operation).toBe("load");
      expect(mocks.capture).toHaveBeenCalledTimes(1);

      let retryResult: Task | null | undefined;
      await act(async () => {
        retryResult = await latest?.addTask({ title: "Retry", category: "personal" });
      });

      expect(retryResult).toEqual(retryTask);
      expect(latest?.tasks).toEqual([retryTask]);
      expect(latest?.error).toBeNull();
      expect(mocks.getUser).toHaveBeenCalledTimes(4);
      expect(mocks.from).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["resolves", "no-user", "missing-session", "throws-missing-session"] as const)(
    "keeps a null-owner pending A mutation neutral when a B refresh succeeds and A auth %s",
    async (outcome) => {
      const ownerB = { id: "task-owner-b" };
      const taskB = { ...task("owner-b"), user_id: ownerB.id };
      const pendingAuth = deferred<{
        data: { user: typeof user | null };
        error: unknown;
      }>();
      const loadB = loadBuilder(Promise.resolve({ data: [taskB], error: null }));
      mocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: null })
        .mockReturnValueOnce(pendingAuth.promise)
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
      mocks.from.mockReturnValueOnce(loadB.builder);

      act(() => root?.render(<Probe />));
      await act(flush);
      let pendingAdd!: Promise<Task | null | undefined>;
      act(() => {
        pendingAdd = Promise.resolve(
          latest?.addTask({ title: "Owner A pending", category: "personal" }),
        );
      });
      await act(flush);

      await act(async () => { await latest?.refresh(); });
      expect(latest?.tasks).toEqual([taskB]);

      if (outcome === "resolves") {
        pendingAuth.resolve({ data: { user }, error: null });
      } else if (outcome === "no-user") {
        pendingAuth.resolve({ data: { user: null }, error: null });
      } else if (outcome === "missing-session") {
        pendingAuth.resolve({
          data: { user: null },
          error: { status: 401, message: "session expired" },
        });
      } else {
        pendingAuth.reject({
          name: "AuthSessionMissingError",
          status: 400,
          message: "Auth session missing!",
        });
      }
      let result: Task | null | undefined;
      await act(async () => { result = await pendingAdd; });

      expect(result).toBeNull();
      expect(mocks.from).toHaveBeenCalledTimes(1);
      expect(latest?.tasks).toEqual([taskB]);
      expect(latest?.error).toBeNull();
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["owner-b", "resolves"],
    ["owner-b", "rejects"],
    ["no-user", "resolves"],
    ["no-user", "rejects"],
    ["missing-session", "resolves"],
    ["missing-session", "rejects"],
    ["throws-missing-session", "resolves"],
    ["throws-missing-session", "rejects"],
  ] as const)(
    "retires an initial A claim when concurrent auth returns %s and the older A write %s",
    async (authOutcome, olderOutcome) => {
      const ownerB = { id: "task-owner-b" };
      const taskB = { ...task("owner-b"), user_id: ownerB.id };
      const firstAuth = deferred<{
        data: { user: typeof user | null };
        error: unknown;
      }>();
      const conflictingAuth = deferred<{
        data: { user: typeof user | null };
        error: unknown;
      }>();
      const olderPending = deferred<{ data: Task | null; error: unknown }>();
      const olderMutation = mutationBuilder(() => olderPending.promise);
      const loadB = loadBuilder(Promise.resolve({ data: [taskB], error: null }));
      mocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: null })
        .mockReturnValueOnce(firstAuth.promise)
        .mockReturnValueOnce(conflictingAuth.promise);
      if (authOutcome === "owner-b") {
        mocks.getUser.mockResolvedValueOnce({ data: { user: ownerB }, error: null });
      } else {
        mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
      }
      mocks.from.mockReturnValueOnce(olderMutation);
      if (authOutcome === "owner-b") {
        mocks.from.mockReturnValueOnce(loadB.builder);
      }

      act(() => root?.render(<Probe />));
      await act(flush);
      let older!: Promise<Task | null | undefined>;
      let conflicting!: Promise<Task | null | undefined>;
      act(() => {
        older = Promise.resolve(
          latest?.addTask({ title: "Owner A", category: "personal" }),
        );
        conflicting = Promise.resolve(
          latest?.addTask({ title: "Conflicting subject", category: "personal" }),
        );
      });
      firstAuth.resolve({ data: { user }, error: null });
      await act(flush);
      expect(mocks.from).toHaveBeenCalledTimes(1);

      if (authOutcome === "owner-b") {
        conflictingAuth.resolve({ data: { user: ownerB }, error: null });
      } else if (authOutcome === "no-user") {
        conflictingAuth.resolve({ data: { user: null }, error: null });
      } else if (authOutcome === "missing-session") {
        conflictingAuth.resolve({
          data: { user: null },
          error: { status: 401, message: "session expired" },
        });
      } else {
        conflictingAuth.reject({
          name: "AuthSessionMissingError",
          status: 400,
          message: "Auth session missing!",
        });
      }
      let conflictingResult: Task | null | undefined;
      await act(async () => { conflictingResult = await conflicting; });
      await act(flush);

      expect(conflictingResult).toBeNull();
      if (authOutcome === "owner-b") {
        expect(latest?.tasks).toEqual([taskB]);
        expect(latest?.error).toEqual({
          operation: "add",
          message: "Account changed — tasks reloaded for the current account. Retry your action.",
        });
        expect(mocks.from).toHaveBeenCalledTimes(2);
      } else {
        expect(latest?.tasks).toEqual([]);
        expect(latest?.error).toEqual({
          operation: "add",
          message: "Account changed — sign in to continue.",
        });
        expect(mocks.from).toHaveBeenCalledTimes(1);
      }

      if (olderOutcome === "resolves") {
        olderPending.resolve({ data: task("older-a"), error: null });
      } else {
        olderPending.reject({ status: 500, message: "retired owner A failure" });
      }
      let olderResult: Task | null | undefined;
      await act(async () => { olderResult = await older; });

      expect(olderResult).toBeNull();
      expect(latest?.tasks).toEqual(authOutcome === "owner-b" ? [taskB] : []);
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["returns", "resolves"],
    ["returns", "rejects"],
    ["throws", "resolves"],
    ["throws", "rejects"],
  ] as const)(
    "keeps a provisional A claim when concurrent auth %s a contradictory 5xx and the A write %s",
    async (authOutcome, olderOutcome) => {
      const firstAuth = deferred<{
        data: { user: typeof user | null };
        error: unknown;
      }>();
      const conflictingAuth = deferred<{
        data: { user: typeof user | null };
        error: unknown;
      }>();
      const olderPending = deferred<{ data: Task | null; error: unknown }>();
      const olderMutation = mutationBuilder(() => olderPending.promise);
      mocks.getUser
        .mockResolvedValueOnce({ data: { user: null }, error: null })
        .mockReturnValueOnce(firstAuth.promise)
        .mockReturnValueOnce(conflictingAuth.promise);
      mocks.from.mockReturnValueOnce(olderMutation);

      act(() => root?.render(<Probe />));
      await act(flush);
      let older!: Promise<Task | null | undefined>;
      let conflicting!: Promise<Task | null | undefined>;
      act(() => {
        older = Promise.resolve(
          latest?.addTask({ title: "Owner A", category: "personal" }),
        );
        conflicting = Promise.resolve(
          latest?.addTask({ title: "Contradictory auth", category: "personal" }),
        );
      });
      firstAuth.resolve({ data: { user }, error: null });
      await act(flush);
      expect(mocks.from).toHaveBeenCalledTimes(1);

      const contradictory = {
        name: "AuthSessionMissingError",
        status: 500,
        message: "contradictory server auth failure",
      };
      if (authOutcome === "returns") {
        conflictingAuth.resolve({ data: { user: null }, error: contradictory });
      } else {
        conflictingAuth.reject(contradictory);
      }
      let conflictingResult: Task | null | undefined;
      await act(async () => { conflictingResult = await conflicting; });

      expect(conflictingResult).toBeNull();
      expect(latest?.tasks).toEqual([]);
      expect(latest?.error).toEqual({
        operation: "add",
        message: "Could not create task — sign in again and retry.",
      });
      expect(mocks.capture).toHaveBeenCalledTimes(1);
      expect(mocks.getUser).toHaveBeenCalledTimes(3);
      expect(mocks.from).toHaveBeenCalledTimes(1);

      if (olderOutcome === "resolves") {
        olderPending.resolve({ data: task("owner-a"), error: null });
      } else {
        olderPending.reject({ status: 503, message: "owner A write failure" });
      }
      let olderResult: Task | null | undefined;
      await act(async () => { olderResult = await older; });

      if (olderOutcome === "resolves") {
        expect(olderResult).toEqual(task("owner-a"));
        expect(latest?.tasks).toEqual([task("owner-a")]);
        expect(latest?.error).toBeNull();
        expect(mocks.capture).toHaveBeenCalledTimes(1);
      } else {
        expect(olderResult).toBeNull();
        expect(latest?.tasks).toEqual([]);
        expect(latest?.error).toEqual({
          operation: "add",
          message: "Could not create task — check your connection and retry.",
        });
        expect(mocks.capture).toHaveBeenCalledTimes(2);
      }
      expect(mocks.getUser).toHaveBeenCalledTimes(3);
      expect(mocks.from).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers owner B after a mismatch reload fails and is retried", async () => {
    const ownerB = { id: "task-owner-b" };
    const taskB = { ...task("owner-b"), user_id: ownerB.id };
    const loadA = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const failedLoadB = loadBuilder(Promise.resolve({
      data: null,
      error: { status: 503, message: "temporary owner B load failure" },
    }));
    const retriedLoadB = loadBuilder(Promise.resolve({ data: [taskB], error: null }));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
      .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
      .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
    mocks.from
      .mockReturnValueOnce(loadA.builder)
      .mockReturnValueOnce(failedLoadB.builder)
      .mockReturnValueOnce(retriedLoadB.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    let result: Task | null | undefined;
    await act(async () => {
      result = await latest?.addTask({ title: "Wrong owner", category: "personal" });
    });
    await act(flushFailureCommit);

    expect(result).toBeNull();
    expect(latest?.tasks).toEqual([]);
    expect(latest?.error?.operation).toBe("load");
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    await act(async () => { await latest?.refresh(); });

    expect(mocks.from).toHaveBeenCalledTimes(3);
    expect(latest?.tasks).toEqual([taskB]);
    expect(latest?.error).toBeNull();
  });

  it("preserves concurrent initial same-owner mutations when both claim owner A", async () => {
    const firstPending = deferred<{ data: Task | null; error: unknown }>();
    const secondPending = deferred<{ data: Task | null; error: unknown }>();
    const firstMutation = mutationBuilder(() => firstPending.promise);
    const secondMutation = mutationBuilder(() => secondPending.promise);
    mocks.getUser
      .mockResolvedValueOnce({ data: { user: null }, error: null })
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockResolvedValueOnce({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(firstMutation)
      .mockReturnValueOnce(secondMutation);

    act(() => root?.render(<Probe />));
    await act(flush);
    let first!: Promise<Task | null | undefined>;
    let second!: Promise<Task | null | undefined>;
    act(() => {
      first = Promise.resolve(
        latest?.addTask({ title: "First", category: "personal" }),
      );
      second = Promise.resolve(
        latest?.addTask({ title: "Second", category: "personal" }),
      );
    });
    await act(flush);

    secondPending.resolve({ data: task("second"), error: null });
    firstPending.resolve({ data: task("first"), error: null });
    let firstResult: Task | null | undefined;
    let secondResult: Task | null | undefined;
    await act(async () => {
      [firstResult, secondResult] = await Promise.all([first, second]);
    });

    expect(firstResult?.id).toBe("first");
    expect(secondResult?.id).toBe("second");
    expect(latest?.tasks.map((item) => item.id).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(latest?.error).toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each(["resolves", "rejects"] as const)(
    "makes an A mutation neutral when a refresh establishes owner B and the A request %s",
    async (outcome) => {
      const ownerB = { id: "task-owner-b" };
      const pending = deferred<{ data: Task | null; error: unknown }>();
      const loadA = loadBuilder(Promise.resolve({ data: [task("owner-a")], error: null }));
      const mutationA = mutationBuilder(() => pending.promise);
      const taskB = { ...task("owner-b"), user_id: ownerB.id };
      const loadB = loadBuilder(Promise.resolve({ data: [taskB], error: null }));
      mocks.getUser
        .mockResolvedValueOnce({ data: { user }, error: null })
        .mockResolvedValueOnce({ data: { user }, error: null })
        .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
      mocks.from
        .mockReturnValueOnce(loadA.builder)
        .mockReturnValueOnce(mutationA)
        .mockReturnValueOnce(loadB.builder);

      act(() => root?.render(<Probe />));
      await act(flush);
      let pendingAdd!: Promise<Task | null | undefined>;
      act(() => {
        pendingAdd = Promise.resolve(
          latest?.addTask({ title: "Owner A pending", category: "personal" }),
        );
      });
      await act(flush);

      await act(async () => { await latest?.refresh(); });
      expect(latest?.tasks).toEqual([taskB]);

      if (outcome === "resolves") {
        pending.resolve({ data: task("owner-a-late"), error: null });
      } else {
        pending.reject({ status: 500, message: "stale owner A write failure" });
      }
      let result: Task | null | undefined;
      await act(async () => { result = await pendingAdd; });

      expect(result).toBeNull();
      expect(latest?.tasks).toEqual([taskB]);
      expect(latest?.error).toBeNull();
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );

  it.each(["resolves", "rejects"] as const)(
    "makes a pending mutation neutral when pagehide retires ownership and the request %s",
    async (outcome) => {
      const pending = deferred<{ data: Task | null; error: unknown }>();
      const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
      const mutation = mutationBuilder(() => pending.promise);
      mocks.getUser.mockResolvedValue({ data: { user }, error: null });
      mocks.from
        .mockReturnValueOnce(load.builder)
        .mockReturnValueOnce(mutation);

      act(() => root?.render(<Probe />));
      await act(flush);
      let pendingAdd!: Promise<Task | null | undefined>;
      act(() => {
        pendingAdd = Promise.resolve(
          latest?.addTask({ title: "Pending", category: "personal" }),
        );
      });
      await act(flush);

      act(() => window.dispatchEvent(new Event("pagehide")));
      if (outcome === "resolves") {
        pending.resolve({ data: task("late"), error: null });
      } else {
        pending.reject({ status: 500, message: "late failure" });
      }
      let result: Task | null | undefined;
      await act(async () => { result = await pendingAdd; });

      expect(result).toBeNull();
      expect(latest?.tasks.map((item) => item.id)).toEqual(["known"]);
      expect(latest?.error).toBeNull();
      expect(mocks.capture).not.toHaveBeenCalled();
    },
  );

  it("keeps a pending mutation neutral across a BFCache retirement and restore", async () => {
    const pending = deferred<{ data: Task | null; error: unknown }>();
    const initial = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const mutation = mutationBuilder(() => pending.promise);
    const restored = loadBuilder(Promise.resolve({ data: [task("restored")], error: null }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(initial.builder)
      .mockReturnValueOnce(mutation)
      .mockReturnValueOnce(restored.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    let pendingAdd!: Promise<Task | null | undefined>;
    act(() => {
      pendingAdd = Promise.resolve(
        latest?.addTask({ title: "Pending", category: "personal" }),
      );
    });
    await act(flush);

    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(persistedPageShow()));
    await act(flush);
    pending.resolve({ data: task("late"), error: null });
    let result: Task | null | undefined;
    await act(async () => { result = await pendingAdd; });

    expect(result).toBeNull();
    expect(latest?.tasks.map((item) => item.id)).toEqual(["restored"]);
    expect(latest?.error).toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not resurrect retired account-change feedback after a BFCache restore", async () => {
    const ownerB = { id: "task-owner-b" };
    const taskB = { ...task("owner-b"), user_id: ownerB.id };
    const pendingRecovery = deferred<{ data: Task[] | null; error: unknown }>();
    const initial = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const recovery = loadBuilder(pendingRecovery.promise);
    const restored = loadBuilder(Promise.resolve({ data: [taskB], error: null }));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
      .mockResolvedValueOnce({ data: { user: ownerB }, error: null })
      .mockResolvedValueOnce({ data: { user: ownerB }, error: null });
    mocks.from
      .mockReturnValueOnce(initial.builder)
      .mockReturnValueOnce(recovery.builder)
      .mockReturnValueOnce(restored.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    let result: Task | null | undefined;
    await act(async () => {
      result = await latest?.addTask({ title: "Wrong owner", category: "personal" });
    });

    expect(result).toBeNull();
    expect(latest?.error).toEqual({
      operation: "add",
      message: "Account changed — reloading tasks for the current account.",
    });
    expect(recovery.signals).toHaveLength(1);

    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(persistedPageShow()));
    await act(flush);

    expect(recovery.signals[0].aborted).toBe(true);
    expect(latest?.tasks).toEqual([taskB]);
    expect(latest?.error).toBeNull();

    pendingRecovery.resolve({ data: [taskB], error: null });
    await act(flush);

    expect(latest?.tasks).toEqual([taskB]);
    expect(latest?.error).toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps a pending mutation neutral when a StrictMode remount retires its hook", async () => {
    const pending = deferred<{ data: Task | null; error: unknown }>();
    const initial = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const mutation = mutationBuilder(() => pending.promise);
    const replacement = loadBuilder(Promise.resolve({ data: [task("replacement")], error: null }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(initial.builder)
      .mockReturnValueOnce(mutation)
      .mockReturnValueOnce(replacement.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    let pendingAdd!: Promise<Task | null | undefined>;
    act(() => {
      pendingAdd = Promise.resolve(
        latest?.addTask({ title: "Pending", category: "personal" }),
      );
    });
    await act(flush);

    act(() => root?.render(<StrictMode><Probe key="replacement" /></StrictMode>));
    await act(flush);
    pending.resolve({ data: task("late"), error: null });
    let result: Task | null | undefined;
    await act(async () => { result = await pendingAdd; });

    expect(result).toBeNull();
    expect(latest?.tasks.map((item) => item.id)).toEqual(["replacement"]);
    expect(latest?.error).toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("preserves concurrent valid same-owner adds when ownership does not change", async () => {
    const firstPending = deferred<{ data: Task | null; error: unknown }>();
    const secondPending = deferred<{ data: Task | null; error: unknown }>();
    const load = loadBuilder(Promise.resolve({ data: [], error: null }));
    const firstMutation = mutationBuilder(() => firstPending.promise);
    const secondMutation = mutationBuilder(() => secondPending.promise);
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(load.builder)
      .mockReturnValueOnce(firstMutation)
      .mockReturnValueOnce(secondMutation);

    act(() => root?.render(<Probe />));
    await act(flush);
    let first!: Promise<Task | null | undefined>;
    let second!: Promise<Task | null | undefined>;
    act(() => {
      first = Promise.resolve(
        latest?.addTask({ title: "First", category: "personal" }),
      );
      second = Promise.resolve(
        latest?.addTask({ title: "Second", category: "personal" }),
      );
    });
    await act(flush);

    secondPending.resolve({ data: task("second"), error: null });
    firstPending.resolve({ data: task("first"), error: null });
    let firstResult: Task | null | undefined;
    let secondResult: Task | null | undefined;
    await act(async () => {
      [firstResult, secondResult] = await Promise.all([first, second]);
    });

    expect(firstResult?.id).toBe("first");
    expect(secondResult?.id).toBe("second");
    expect(latest?.tasks.map((item) => item.id).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(latest?.error).toBeNull();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), null, "Sign in to create tasks."],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), null, "Sign in to update tasks."],
    ["delete", async () => latest?.deleteTask("known"), false, "Sign in to delete tasks."],
    ["toggle", async () => latest?.toggleDone("known"), null, "Sign in to update tasks."],
  ])("keeps %s fail-closed for a resolved missing session", async (_case, invoke, expected, message) => {
    const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockResolvedValueOnce({
        data: { user: null },
        error: { status: 401, message: "session expired" },
      });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    mocks.from.mockClear();
    mocks.capture.mockClear();

    let result: unknown;
    await act(async () => { result = await invoke(); });

    expect(result).toBe(expected);
    expect(latest?.tasks).toEqual([]);
    expect(latest?.error?.message).toBe(message);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), null, "Sign in to create tasks."],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), null, "Sign in to update tasks."],
    ["delete", async () => latest?.deleteTask("known"), false, "Sign in to delete tasks."],
    ["toggle", async () => latest?.toggleDone("known"), null, "Sign in to update tasks."],
  ])("keeps %s fail-closed for a thrown exact missing session", async (_case, invoke, expected, message) => {
    const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockRejectedValueOnce({ message: "Auth session missing!" });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    mocks.from.mockClear();
    mocks.capture.mockClear();

    let result: unknown;
    await act(async () => { result = await invoke(); });

    expect(result).toBe(expected);
    expect(latest?.tasks).toEqual([]);
    expect(latest?.error?.message).toBe(message);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), "add"],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), "update"],
    ["delete", async () => latest?.deleteTask("known"), "delete"],
    ["toggle", async () => latest?.toggleDone("known"), "update"],
  ])("keeps a thrown %s AuthSessionMissingError-shaped 500 actionable", async (_case, invoke, operation) => {
    const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    mocks.getUser
      .mockResolvedValueOnce({ data: { user }, error: null })
      .mockRejectedValueOnce({
        name: "AuthSessionMissingError",
        status: 500,
        message: "upstream auth failure",
      });
    mocks.from.mockReturnValue(load.builder);

    act(() => root?.render(<Probe />));
    await act(flush);
    mocks.from.mockClear();
    mocks.capture.mockClear();

    await act(async () => { await invoke(); });

    expect(latest?.error?.operation).toBe(operation);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), null, "Sign in to create tasks."],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), null, "Sign in to update tasks."],
    ["delete", async () => latest?.deleteTask("known"), false, "Sign in to delete tasks."],
    ["toggle", async () => latest?.toggleDone("known"), null, "Sign in to update tasks."],
  ])("keeps %s fail-closed when the post-auth mutation returns session expiry", async (_case, invoke, expected, message) => {
    const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const mutation = mutationBuilder(() => Promise.resolve({
      data: null,
      error: { status: 401, message: "session expired during mutation" },
    }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(load.builder)
      .mockReturnValueOnce(mutation);

    act(() => root?.render(<Probe />));
    await act(flush);
    mocks.from.mockClear();
    mocks.capture.mockClear();

    let result: unknown;
    await act(async () => { result = await invoke(); });

    expect(result).toBe(expected);
    expect(latest?.tasks).toEqual([]);
    expect(latest?.error?.message).toBe(message);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), null, "Sign in to create tasks."],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), null, "Sign in to update tasks."],
    ["delete", async () => latest?.deleteTask("known"), false, "Sign in to delete tasks."],
    ["toggle", async () => latest?.toggleDone("known"), null, "Sign in to update tasks."],
  ])("keeps %s fail-closed when the post-auth mutation throws exact session expiry", async (_case, invoke, expected, message) => {
    const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const mutation = mutationBuilder(() => Promise.reject({
      message: "Auth session missing!",
      status: 400,
    }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(load.builder)
      .mockReturnValueOnce(mutation);

    act(() => root?.render(<Probe />));
    await act(flush);
    mocks.from.mockClear();
    mocks.capture.mockClear();

    let result: unknown;
    await act(async () => { result = await invoke(); });

    expect(result).toBe(expected);
    expect(latest?.tasks).toEqual([]);
    expect(latest?.error?.message).toBe(message);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each([
    ["add", async () => latest?.addTask({ title: "New", category: "personal" }), "add"],
    ["update", async () => latest?.updateTask("known", { title: "Changed" }), "update"],
    ["delete", async () => latest?.deleteTask("known"), "delete"],
    ["toggle", async () => latest?.toggleDone("known"), "update"],
  ])("captures one actionable %s post-auth mutation 500", async (_case, invoke, operation) => {
    const load = loadBuilder(Promise.resolve({ data: [task("known")], error: null }));
    const mutation = mutationBuilder(() => Promise.resolve({
      data: null,
      error: {
        name: "AuthSessionMissingError",
        status: 500,
        message: "upstream mutation auth failure",
      },
    }));
    mocks.getUser.mockResolvedValue({ data: { user }, error: null });
    mocks.from
      .mockReturnValueOnce(load.builder)
      .mockReturnValueOnce(mutation);

    act(() => root?.render(<Probe />));
    await act(flush);
    mocks.from.mockClear();
    mocks.capture.mockClear();

    await act(async () => { await invoke(); });

    expect(latest?.error?.operation).toBe(operation);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
});
