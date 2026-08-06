// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INTERFACE_SETTINGS } from "@/lib/theme/interface-settings";

const mocks = vi.hoisted(() => ({
  authCallback: null as ((event?: string, session?: unknown) => void) | null,
  capture: vi.fn(),
  eq: vi.fn(),
  fetch: vi.fn(),
  from: vi.fn(),
  rlsRead: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.capture }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    let readSignal: AbortSignal | undefined;
    query.select = vi.fn(() => query);
    query.eq = mocks.eq;
    query.abortSignal = vi.fn((signal: AbortSignal) => {
      readSignal = signal;
      return query;
    });
    query.maybeSingle = vi.fn(() => mocks.rlsRead(readSignal));
    mocks.from.mockReturnValue(query);
    return {
      auth: {
        onAuthStateChange: (callback: (event?: string, session?: unknown) => void) => {
          mocks.authCallback = callback;
          return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
        },
      },
      from: mocks.from,
    };
  },
}));

import { ThemeProvider, useTheme } from "./ThemeProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;
const SETTINGS_A = {
  ...DEFAULT_INTERFACE_SETTINGS,
  accent: "sage" as const,
  surfaceTone: "lifted" as const,
};
const SETTINGS_B = {
  ...DEFAULT_INTERFACE_SETTINGS,
  accent: "marine" as const,
  surfaceTone: "deep" as const,
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function response(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
  };
}

function readResponse(
  subject = SUBJECT_A,
  envelope: Record<string, unknown> = {},
) {
  return response(200, { subject, envelope });
}

function preferenceRow(envelope: Record<string, unknown> = {}) {
  return { data: { interface_settings: envelope }, error: null };
}

let observed: ReturnType<typeof useTheme> | null;
let root: Root | null;

function Probe() {
  observed = useTheme();
  return <output>{`${observed.interfacePersistence}:${observed.theme}`}</output>;
}

function current() {
  if (!observed) throw new Error("Theme context was not observed");
  return observed;
}

async function renderProvider() {
  act(() => root?.render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  ));
  await act(flushMicrotasks);
}

function reads() {
  return mocks.fetch.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "GET",
  );
}

function writes() {
  return mocks.fetch.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.authCallback = null;
  mocks.capture.mockReset();
  mocks.fetch.mockReset();
  mocks.eq.mockReset();
  mocks.from.mockReset();
  mocks.rlsRead.mockReset();
  mocks.rlsRead.mockResolvedValue(preferenceRow());
  mocks.unsubscribe.mockReset();
  observed = null;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  observed = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ThemeProvider route-bound preference lifecycle", () => {
  it("drops a transition-null rejection when pagehide follows in the next task", async () => {
    const pending = deferred<unknown>();
    let signal: AbortSignal | null | undefined;
    mocks.fetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal;
      return pending.promise;
    });

    await renderProvider();
    pending.reject(new Error("navigation interrupted preference load"));
    await act(flushMicrotasks);
    expect(mocks.capture).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(signal?.aborted).toBe(true);
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("reports a genuine live network failure once, one task later", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("live preference failure"));

    await renderProvider();
    expect(mocks.capture).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: {
          area: "profile",
          provider: "supabase",
          operation: "load",
        },
      },
    );
  });

  it("rechecks exact ownership after a response-body rejection", async () => {
    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: vi.fn().mockRejectedValue(new Error("body stream closed")),
    });

    await renderProvider();
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures malformed successful contracts but does not duplicate route 5xx", async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, {
      subject: SUBJECT_A,
      envelope: {},
      user_id: "must-not-cross-the-route",
    }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(current().interfacePersistence).toBe("error");

    mocks.fetch.mockResolvedValueOnce(response(500, {
      error: "PREFERENCES_UNAVAILABLE",
    }));
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    mocks.fetch.mockResolvedValueOnce({
      status: 502,
      ok: false,
      json: vi.fn().mockRejectedValue(new Error("non-json gateway response")),
    });
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("captures unexpected save failures but suppresses only exact route errors", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(500, {
        error: "PREFERENCES_UNAVAILABLE",
      }))
      .mockResolvedValueOnce(response(502, {
        error: "PREFERENCES_UNAVAILABLE",
        detail: "unexpected-contract",
      }));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).not.toHaveBeenCalled();

    act(() => current().setTheme("slate"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("discards A and ownershipless edits when B resolves with an empty envelope", async () => {
    const pendingB = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => pendingB.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B));

    await renderProvider();
    expect(current().interfacePersistence).toBe("synced");

    act(() => mocks.authCallback?.("SIGNED_IN", {
      user: { id: "browser-session-is-not-authority" },
    }));
    expect(current().interfacePersistence).toBe("loading");
    act(() => current().setTheme("slate"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    pendingB.resolve(readResponse(SUBJECT_B));
    await act(flushMicrotasks);

    expect(current().theme).toBe("dark");
    expect(current().interfaceSettings).toEqual(DEFAULT_INTERFACE_SETTINGS);
    expect(current().interfacePersistence).toBe("synced");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(0);
  });

  it("stages an edit after opaque identity resolves while the direct RLS read is pending", async () => {
    const pendingRead = deferred<unknown>();
    let directSignal: AbortSignal | undefined;
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead.mockImplementationOnce((signal: AbortSignal) => {
      directSignal = signal;
      return pendingRead.promise;
    });

    await renderProvider();
    expect(current().interfacePersistence).toBe("loading");
    expect(mocks.from).toHaveBeenCalledWith("user_preferences");
    expect(mocks.eq).not.toHaveBeenCalled();

    act(() => current().setTheme("dim"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    pendingRead.resolve(preferenceRow({ theme: "dark" }));
    await act(flushMicrotasks);
    expect(current().theme).toBe("dim");
    expect(directSignal?.aborted).toBe(false);

    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
    const body = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(body).toEqual(expect.objectContaining({
      subject: SUBJECT_A,
      envelope: expect.objectContaining({ theme: "dim" }),
    }));
    expect(JSON.stringify(mocks.fetch.mock.calls)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });

  it("merges a B-bound theme edit onto B settings without copying A settings", async () => {
    const pendingBRead = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "light",
        settings: SETTINGS_A,
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, {
        theme: "slate",
        settings: SETTINGS_B,
      }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockImplementationOnce(() => pendingBRead.promise);

    await renderProvider();
    expect(current().interfaceSettings).toEqual(SETTINGS_A);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => current().setTheme("dim"));
    pendingBRead.resolve(preferenceRow({ settings: SETTINGS_A }));
    await act(flushMicrotasks);

    expect(current().theme).toBe("dim");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    const body = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(body.subject).toBe(SUBJECT_B);
    expect(body.envelope.theme).toBe("dim");
    expect(body.envelope.settings).toEqual(SETTINGS_B);
  });

  it("merges a B-bound settings edit while retaining B's authoritative theme", async () => {
    const pendingBRead = deferred<unknown>();
    const editedSettings = { ...SETTINGS_A, density: "compact" as const };
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "light",
        settings: SETTINGS_A,
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, {
        theme: "slate",
        settings: SETTINGS_B,
      }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockImplementationOnce(() => pendingBRead.promise);

    await renderProvider();
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => current().setInterfaceSettings(editedSettings));
    pendingBRead.resolve(preferenceRow({ theme: "light" }));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    expect(current().interfaceSettings).toEqual(editedSettings);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    const body = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(body.subject).toBe(SUBJECT_B);
    expect(body.envelope.theme).toBe("slate");
    expect(body.envelope.settings).toEqual(editedSettings);
  });

  it("promotes a theme-only edit made before the initial S1 response", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "light",
        settings: SETTINGS_B,
      }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("dim"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().theme).toBe("dim");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(JSON.parse(String((writes()[0]?.[1] as RequestInit).body)).envelope)
      .toEqual(expect.objectContaining({
        theme: "dim",
        settings: SETTINGS_B,
      }));
  });

  it("promotes a settings-only edit made before the initial S1 response", async () => {
    const pendingS1 = deferred<unknown>();
    const editedSettings = { ...DEFAULT_INTERFACE_SETTINGS, density: "compact" as const };
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "slate",
        settings: SETTINGS_B,
      }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setInterfaceSettings(editedSettings));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    expect(current().interfaceSettings).toEqual(editedSettings);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(JSON.parse(String((writes()[0]?.[1] as RequestInit).body)).envelope)
      .toEqual(expect.objectContaining({
        theme: "slate",
        settings: editedSettings,
      }));
  });

  it("ignores browser RLS row data and applies only the authoritative S2 envelope", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "light",
        settings: SETTINGS_A,
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "slate",
        settings: SETTINGS_B,
      }));
    mocks.rlsRead.mockResolvedValueOnce(preferenceRow({
      theme: "light",
      settings: SETTINGS_A,
    }));

    await renderProvider();

    expect(current().theme).toBe("slate");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    expect(writes()).toHaveLength(0);
  });

  it("captures a direct RLS read failure once and never performs a blind PUT", async () => {
    mocks.fetch.mockResolvedValueOnce(readResponse(SUBJECT_A));
    mocks.rlsRead.mockResolvedValueOnce({
      data: null,
      error: {
        message: "private direct read detail",
        status: 503,
        code: "PGRST301",
      },
    });

    await renderProvider();
    expect(mocks.capture).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          status: "503",
          code: "PROFILE_LOAD_FAILED",
          transport: "direct",
        }),
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private direct read detail",
    );
    act(() => current().setTheme("slate"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);
  });

  it("does not duplicate an exact route 500 from the S2 identity check", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(500, {
        error: "PREFERENCES_UNAVAILABLE",
      }));

    await renderProvider();

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("drops a stale direct A response after authoritative identity changes to B", async () => {
    const pendingA = deferred<unknown>();
    let signalA: AbortSignal | undefined;
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "slate" }));
    mocks.rlsRead
      .mockImplementationOnce((signal: AbortSignal) => {
        signalA = signal;
        return pendingA.promise;
      })
      .mockResolvedValueOnce(preferenceRow({ theme: "slate" }));

    await renderProvider();
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);

    expect(signalA?.aborted).toBe(true);
    expect(current().theme).toBe("slate");
    expect(current().interfacePersistence).toBe("synced");

    pendingA.resolve(preferenceRow({ theme: "light" }));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects an S2 mismatch and never transfers the pending A draft to B", async () => {
    const pendingARead = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockImplementationOnce(() => pendingARead.promise);

    await renderProvider();
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => current().setTheme("light"));
    pendingARead.resolve(preferenceRow({ theme: "dark" }));
    await act(flushMicrotasks);

    expect(current().theme).toBe("dark");
    expect(current().interfacePersistence).toBe("synced");
    expect(reads()).toHaveLength(6);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("drops a stale S2 response after a newer B epoch completes", async () => {
    const pendingS2 = deferred<unknown>();
    let staleSignal: AbortSignal | null | undefined;
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        staleSignal = init.signal;
        return pendingS2.promise;
      })
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "slate" }));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow({ theme: "light" }))
      .mockResolvedValueOnce(preferenceRow({ theme: "slate" }));

    await renderProvider();
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);

    expect(staleSignal?.aborted).toBe(true);
    expect(current().theme).toBe("slate");
    pendingS2.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("invalidates A to B to A reads with monotonic ownership epochs", async () => {
    const pendingFirstA = deferred<unknown>();
    const pendingB = deferred<unknown>();
    const signals: AbortSignal[] = [];
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dim" }));
    mocks.rlsRead
      .mockImplementationOnce((signal: AbortSignal) => {
        signals.push(signal);
        return pendingFirstA.promise;
      })
      .mockImplementationOnce((signal: AbortSignal) => {
        signals.push(signal);
        return pendingB.promise;
      })
      .mockResolvedValueOnce(preferenceRow({ theme: "dim" }));

    await renderProvider();
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(current().theme).toBe("dim");
    expect(current().interfacePersistence).toBe("synced");

    pendingB.resolve(preferenceRow({ theme: "slate" }));
    pendingFirstA.resolve(preferenceRow({ theme: "light" }));
    await act(flushMicrotasks);
    expect(current().theme).toBe("dim");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("aborts an in-flight A write before an auth transition can load B", async () => {
    const pendingWrite = deferred<unknown>();
    const pendingB = deferred<unknown>();
    let writeSignal: AbortSignal | null | undefined;
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        writeSignal = init.signal;
        return pendingWrite.promise;
      })
      .mockImplementationOnce(() => pendingB.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writeSignal?.aborted).toBe(false);

    act(() => mocks.authCallback?.("SIGNED_IN"));
    expect(writeSignal?.aborted).toBe(true);
    expect(current().interfacePersistence).toBe("loading");

    pendingWrite.resolve(response(200, { ok: true, subject: SUBJECT_A }));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("loading");
    expect(mocks.capture).not.toHaveBeenCalled();

    pendingB.resolve(readResponse(SUBJECT_B));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
  });

  it("restores and retries a subject-bound dirty edit after hidden same-subject reload", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const pendingReload = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "dark",
        settings: SETTINGS_A,
      }))
      .mockImplementationOnce(() => pendingReload.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "dark",
        settings: SETTINGS_B,
      }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    expect(current().interfaceSettings).toEqual(SETTINGS_A);
    visibility.mockReturnValue("hidden");
    act(() => {
      current().setTheme("light");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    pendingReload.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().theme).toBe("light");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const body = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(body.subject).toBe(SUBJECT_A);
    expect(body.envelope.theme).toBe("light");
  });

  it("stages edits made while a same-subject authoritative reload is pending", async () => {
    const pendingReload = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => pendingReload.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    expect(current().interfacePersistence).toBe("loading");

    act(() => current().setTheme("light"));
    act(() => current().setInterfaceSettings((settings) => ({
      ...settings,
      surfaceTone: "deep",
    })));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    pendingReload.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().theme).toBe("light");
    expect(current().interfaceSettings.surfaceTone).toBe("deep");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const body = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(body).toEqual(expect.objectContaining({
      subject: SUBJECT_A,
      envelope: expect.objectContaining({
        theme: "light",
        settings: expect.objectContaining({ surfaceTone: "deep" }),
      }),
    }));
  });

  it("serializes writes and coalesces newer edits until the active write settles", async () => {
    const pendingFirstWrite = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => pendingFirstWrite.promise)
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);

    act(() => current().setTheme("slate"));
    act(() => current().setInterfaceSettings((settings) => ({
      ...settings,
      surfaceTone: "lifted",
    })));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);

    pendingFirstWrite.resolve(response(200, { ok: true, subject: SUBJECT_A }));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(2);

    const firstBody = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    const finalBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(firstBody.envelope.theme).toBe("light");
    expect(finalBody.envelope).toEqual(expect.objectContaining({
      theme: "slate",
      settings: expect.objectContaining({ surfaceTone: "lifted" }),
    }));
    expect(current().interfacePersistence).toBe("synced");
  });

  it("does not clear a synchronously newer edit before its passive effect queues", async () => {
    const pendingFirstWrite = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => pendingFirstWrite.promise)
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);

    act(() => {
      current().setTheme("slate");
      pendingFirstWrite.resolve(response(200, {
        ok: true,
        subject: SUBJECT_A,
      }));
    });
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(2);
    const finalBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(finalBody.envelope.theme).toBe("slate");
    expect(current().interfacePersistence).toBe("synced");
  });

  it("quarantines hidden auth changes and waits for visible restore", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const pendingB = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => pendingB.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B));

    await renderProvider();
    expect(reads()).toHaveLength(2);

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => mocks.authCallback?.("SIGNED_IN"));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("loading");
    expect(reads()).toHaveLength(2);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(flushMicrotasks);
    expect(reads()).toHaveLength(3);

    pendingB.resolve(readResponse(SUBJECT_B));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
  });

  it("aborts the exact route request on hidden visibility and unmount", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const signals: AbortSignal[] = [];
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return new Promise(() => undefined);
    });

    await renderProvider();
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(signals[0]?.aborted).toBe(true);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(flushMicrotasks);
    expect(signals[1]?.aborted).toBe(false);

    act(() => root?.unmount());
    root = null;
    expect(signals[1]?.aborted).toBe(true);
  });

  it("reloads authoritative ownership after a subject-conflict write", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(409, { error: "PROFILE_SUBJECT_CHANGED" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(reads()).toHaveLength(4);
    expect(current().interfacePersistence).toBe("synced");
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
