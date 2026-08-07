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
  it("retires the exact load before cross-document navigation rejects fetch", async () => {
    const pending = deferred<unknown>();
    let signal: AbortSignal | null | undefined;
    mocks.fetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal;
      return pending.promise;
    });

    await renderProvider();
    act(() => window.dispatchEvent(new Event("beforeunload")));
    expect(signal?.aborted).toBe(true);
    pending.reject(new Error("navigation interrupted preference load"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(current().interfacePersistence).toBe("loading");
  });

  it("recovers authoritatively when another guard cancels beforeunload", async () => {
    const pending = deferred<unknown>();
    let signal: AbortSignal | null | undefined;
    mocks.fetch
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        signal = init.signal;
        return pending.promise;
      })
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A));

    await renderProvider();
    const cancelNavigation = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", cancelNavigation);
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    act(() => window.dispatchEvent(beforeUnload));
    window.removeEventListener("beforeunload", cancelNavigation);
    expect(beforeUnload.defaultPrevented).toBe(true);
    expect(signal?.aborted).toBe(true);
    pending.reject(new Error("cancelled navigation preference load"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(reads()).toHaveLength(3);
  });

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

  it("reports a genuine live network failure once, one animation frame later", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("live preference failure"));

    await renderProvider();
    expect(mocks.capture).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(20));
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
          status: 503,
          code: "PROFILE_LOAD_FAILED",
          transport: "route",
          stage: "request",
        },
      },
    );
  });

  it("deduplicates one failure episode and resets only after a complete sandwich", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error("first live preference failure"))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockResolvedValueOnce({ data: null, error: { status: 503 } });

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      tags: expect.objectContaining({
        code: "PROFILE_LOAD_FAILED",
        transport: "direct",
        stage: "rls",
      }),
    }));
  });

  it("rechecks exact ownership after a response-body rejection", async () => {
    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: vi.fn().mockRejectedValue(new Error("body stream closed")),
    });

    await renderProvider();
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("normalizes a current S2 body failure without retaining its payload", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: vi.fn().mockRejectedValue(new Error("private body detail")),
      });

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: expect.objectContaining({
        status: 502,
        code: "PROFILE_LOAD_FAILED",
        transport: "route",
        stage: "response-body",
      }),
    });
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private body detail",
    );
  });

  it("normalizes a rejected direct RLS promise as a current direct fault", async () => {
    mocks.fetch.mockResolvedValueOnce(readResponse(SUBJECT_A));
    mocks.rlsRead.mockRejectedValueOnce(new Error("private RLS rejection"));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: expect.objectContaining({
        status: 503,
        code: "PROFILE_LOAD_FAILED",
        transport: "direct",
        stage: "rls",
      }),
    });
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private RLS rejection",
    );
  });

  it("captures malformed successful contracts but does not duplicate route 5xx", async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, {
      subject: SUBJECT_A,
      envelope: {},
      user_id: "must-not-cross-the-route",
    }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
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
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it("treats the exact route 401 as an expected signed-out load transition", async () => {
    mocks.fetch.mockResolvedValueOnce(response(401, {
      error: "UNAUTHENTICATED",
    }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("treats the exact middleware 401 at S1 as an expected signed-out load transition", async () => {
    mocks.fetch.mockResolvedValueOnce(response(401, {
      error: "UNAUTHORIZED",
      message: "Sign in required.",
    }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("treats the exact middleware 401 at S2 as an expected signed-out transition without a blind write", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }));

    await renderProvider();
    expect(current().interfacePersistence).toBe("local");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledTimes(1);

    act(() => current().setTheme("slate"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    [401, {
      error: "UNAUTHORIZED",
      message: "Sign in required.",
    }],
    [403, {
      error: "MFA_REQUIRED",
      message: "Complete two-factor authentication to continue.",
    }],
  ])("binds an edit made after S1 across an exact S2 status %i and persists it only after A recovers", async (status, body) => {
    const pendingRead = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(status, body))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead.mockImplementationOnce(() => pendingRead.promise);

    await renderProvider();
    act(() => current().setTheme("dim"));
    pendingRead.resolve(preferenceRow());
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(writes()).toHaveLength(0);
    expect(mocks.capture).not.toHaveBeenCalled();

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("dim");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten).toEqual(expect.objectContaining({
      subject: SUBJECT_A,
      envelope: expect.objectContaining({ theme: "dim" }),
    }));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
  });

  it("binds a pre-S1 ownershipless edit to A across an S2 denial and persists it after A recovers", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps the newest field revision when S2 denial consolidates ownershipless and A-bound edits", async () => {
    const pendingS1 = deferred<unknown>();
    const pendingRead = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead.mockImplementationOnce(() => pendingRead.promise);

    await renderProvider();
    act(() => current().setTheme("light"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    expect(mocks.from).toHaveBeenCalledTimes(1);

    act(() => current().setTheme("dim"));
    pendingRead.resolve(preferenceRow());
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("local");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().theme).toBe("dim");
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("dim");
  });

  it.each([
    [503, {
      error: "AUTH_BACKEND_UNAVAILABLE",
      message: "Authentication infrastructure is temporarily unavailable.",
    }, 0],
    [500, { error: "PREFERENCES_UNAVAILABLE" }, 0],
    [499, { error: "REQUEST_ABORTED" }, 0],
    [200, {
      subject: SUBJECT_A,
      envelope: {},
      extra: "invalid-success-contract",
    }, 1],
  ])("binds a pre-S1 edit to A across terminal S2 status %i and persists it exactly once after A recovers", async (status, terminalBody, expectedCaptures) => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(response(status, terminalBody))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(expectedCaptures);
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
  });

  it.each([
    [503, {
      error: "AUTH_ASSURANCE_UNAVAILABLE",
      message: "Authentication assurance could not be verified.",
    }, 0],
    [500, { error: "PREFERENCES_UNAVAILABLE" }, 0],
    [499, { error: "REQUEST_ABORTED" }, 0],
    [200, {
      subject: SUBJECT_A,
      envelope: {},
      extra: "invalid-success-contract",
    }, 1],
  ])("never transfers an A edit to B after terminal S2 status %i", async (status, terminalBody, expectedCaptures) => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(response(status, terminalBody))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(expectedCaptures);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);
    expect(mocks.capture).toHaveBeenCalledTimes(expectedCaptures);
  });

  it.each([
    [401, {
      error: "UNAUTHORIZED",
      message: "Sign in required.",
    }],
    [403, {
      error: "MFA_REQUIRED",
      message: "Complete two-factor authentication to continue.",
    }],
  ])("never transfers an after-S1 A edit to B after an exact S2 status %i", async (status, body) => {
    const pendingRead = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(status, body))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }));
    mocks.rlsRead.mockImplementationOnce(() => pendingRead.promise);

    await renderProvider();
    act(() => current().setTheme("dim"));
    pendingRead.resolve(preferenceRow());
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("local");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("never transfers a pre-S1 edit bound to A by an S2 denial onto B", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "dark" }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("local");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("dark");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(0);
  });

  it("clears an ownershipless edit when S1 denies access", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "light" }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(response(401, { error: "UNAUTHENTICATED" }));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(mocks.from).not.toHaveBeenCalled();
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);
  });

  it("preserves an A-bound draft across repeated subjectless auth reloads", async () => {
    const initialS1 = deferred<unknown>();
    const staleRecoveryOne = deferred<unknown>();
    const staleRecoveryTwo = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockImplementationOnce(() => staleRecoveryOne.promise)
      .mockImplementationOnce(() => staleRecoveryTwo.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("local");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");

    staleRecoveryOne.resolve(response(401, { error: "UNAUTHENTICATED" }));
    staleRecoveryTwo.resolve(response(500, {
      error: "PREFERENCES_UNAVAILABLE",
    }));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
    expect(writes()).toHaveLength(1);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("preserves an A-bound draft through pagehide and a hidden pageshow before visible recovery", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const initialS1 = deferred<unknown>();
    const staleRecovery = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockImplementationOnce(() => staleRecovery.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);

    visibility.mockReturnValue("hidden");
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("loading");

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("slate");
    expect(writes()).toHaveLength(1);
    staleRecovery.resolve(response(401, { error: "UNAUTHENTICATED" }));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
  });

  it("preserves an A-bound draft when a cancelled beforeunload interrupts a subjectless recovery", async () => {
    const initialS1 = deferred<unknown>();
    const staleRecovery = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockImplementationOnce(() => staleRecovery.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);

    const cancelNavigation = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", cancelNavigation);
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    act(() => window.dispatchEvent(beforeUnload));
    window.removeEventListener("beforeunload", cancelNavigation);
    expect(beforeUnload.defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("slate");
    expect(writes()).toHaveLength(1);
    staleRecovery.resolve(response(500, {
      error: "PREFERENCES_UNAVAILABLE",
    }));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
  });

  it("keeps A pending through a subjectless reload and a completed B sandwich until A returns", async () => {
    const initialS1 = deferred<unknown>();
    const staleRecovery = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockImplementationOnce(() => staleRecovery.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    staleRecovery.resolve(response(401, { error: "UNAUTHENTICATED" }));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps A pending across a completed B sandwich and a later terminal B load", async () => {
    const initialS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(response(500, {
        error: "PREFERENCES_UNAVAILABLE",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("error");
    expect(
      document.querySelector('[data-testid="interface-persistence-error"]')
        ?.textContent,
    ).toContain("Interface preferences could not sync");
    expect(mocks.capture).not.toHaveBeenCalled();

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
  });

  it("keeps A pending when a post-S1 B lifecycle reload is replaced by A", async () => {
    const initialS1 = deferred<unknown>();
    const staleBRead = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockResolvedValueOnce(preferenceRow())
      .mockImplementationOnce(() => staleBRead.promise);

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(mocks.from).toHaveBeenCalledTimes(3);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    staleBRead.resolve(preferenceRow());
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps A isolated while a post-terminal B edit recovers and writes only as B", async () => {
    const initialS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(response(500, {
        error: "PREFERENCES_UNAVAILABLE",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("error");
    act(() => current().setTheme("dim"));
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bBody = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(bBody.subject).toBe(SUBJECT_B);
    expect(bBody.envelope.theme).toBe("dim");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(2);
    const aBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(aBody.subject).toBe(SUBJECT_A);
    expect(aBody.envelope.theme).toBe("slate");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps A isolated while an S2 mismatch restart stages and writes a B edit", async () => {
    const initialS1 = deferred<unknown>();
    const restartedB = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => restartedB.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("loading");
    act(() => current().setTheme("dim"));
    restartedB.resolve(readResponse(SUBJECT_B));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bBody = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(bBody.subject).toBe(SUBJECT_B);
    expect(bBody.envelope.theme).toBe("dim");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(2);
    const aBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(aBody.subject).toBe(SUBJECT_A);
    expect(aBody.envelope.theme).toBe("slate");
  });

  it("keeps A isolated while a subjectless B lifecycle recovery stages and writes a B edit", async () => {
    const initialS1 = deferred<unknown>();
    const staleBRead = deferred<unknown>();
    const restartedB = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockImplementationOnce(() => restartedB.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockResolvedValueOnce(preferenceRow())
      .mockImplementationOnce(() => staleBRead.promise);

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => current().setTheme("dim"));
    restartedB.resolve(readResponse(SUBJECT_B));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bBody = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(bBody.subject).toBe(SUBJECT_B);
    expect(bBody.envelope.theme).toBe("dim");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(2);
    const aBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(aBody.subject).toBe(SUBJECT_A);
    expect(aBody.envelope.theme).toBe("slate");
    staleBRead.resolve(preferenceRow());
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(2);
  });

  it("isolates an edit made after B S1 from retained A and persists each only for its matching subject", async () => {
    const initialS1 = deferred<unknown>();
    const pendingBRead = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead
      .mockResolvedValueOnce(preferenceRow())
      .mockImplementationOnce(() => pendingBRead.promise);

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("local");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(mocks.from).toHaveBeenCalledTimes(2);
    act(() => current().setTheme("dim"));
    pendingBRead.resolve(preferenceRow());
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bBody = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(bBody.subject).toBe(SUBJECT_B);
    expect(bBody.envelope.theme).toBe("dim");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(2);
    const aBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(aBody.subject).toBe(SUBJECT_A);
    expect(aBody.envelope.theme).toBe("slate");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps subjectless lifecycle edits bound to last-authoritative B while retained A remains isolated", async () => {
    const initialS1 = deferred<unknown>();
    const staleSubjectlessOne = deferred<unknown>();
    const staleSubjectlessTwo = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => initialS1.promise)
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockImplementationOnce(() => staleSubjectlessOne.promise)
      .mockImplementationOnce(() => staleSubjectlessTwo.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_B }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    initialS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => current().setTheme("dim"));
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bBody = JSON.parse(String((writes()[0]?.[1] as RequestInit).body));
    expect(bBody.subject).toBe(SUBJECT_B);
    expect(bBody.envelope.theme).toBe("dim");

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(2);
    const aBody = JSON.parse(String((writes()[1]?.[1] as RequestInit).body));
    expect(aBody.subject).toBe(SUBJECT_A);
    expect(aBody.envelope.theme).toBe("slate");

    staleSubjectlessOne.resolve(response(401, { error: "UNAUTHENTICATED" }));
    staleSubjectlessTwo.resolve(response(500, {
      error: "PREFERENCES_UNAVAILABLE",
    }));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(2);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not let a stale S2 denial retire a newer generation", async () => {
    const staleS2 = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => staleS2.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }));

    await renderProvider();
    act(() => current().setTheme("dim"));
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    staleS2.resolve(response(401, {
      error: "UNAUTHORIZED",
      message: "Sign in required.",
    }));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    expect(writes()).toHaveLength(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not let a stale terminal S2 failure retire or rebind a newer generation", async () => {
    const staleS2 = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce(() => staleS2.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "slate" }));

    await renderProvider();
    act(() => current().setTheme("dim"));
    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("slate");

    staleS2.resolve(response(500, { error: "PREFERENCES_UNAVAILABLE" }));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("slate");
    expect(writes()).toHaveLength(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("quarantines an exact middleware 401 PUT and restores its subject-bound edit after a valid sandwich", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(401, {
        error: "UNAUTHORIZED",
        message: "Sign in required.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    expect(writes()).toHaveLength(2);
    const recoveredBody = JSON.parse(
      String((writes()[1]?.[1] as RequestInit).body),
    );
    expect(recoveredBody).toEqual(expect.objectContaining({
      subject: SUBJECT_A,
      envelope: expect.objectContaining({ theme: "light" }),
    }));
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("treats the exact middleware MFA boundary as a local access transition", async () => {
    mocks.fetch.mockResolvedValueOnce(response(403, {
      error: "MFA_REQUIRED",
      message: "Complete two-factor authentication to continue.",
    }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("local");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    [
      "AUTH_CONFIGURATION_UNAVAILABLE",
      "Authentication infrastructure is temporarily unavailable.",
    ],
    [
      "AUTH_BACKEND_UNAVAILABLE",
      "Authentication infrastructure is temporarily unavailable.",
    ],
    [
      "AUTH_ASSURANCE_UNAVAILABLE",
      "Authentication assurance could not be verified.",
    ],
  ])("does not duplicate the exact middleware-owned 503 %s", async (error, message) => {
    mocks.fetch.mockResolvedValueOnce(response(503, { error, message }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not duplicate an exact middleware-owned 503 from a preference PUT", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(503, {
        error: "AUTH_BACKEND_UNAVAILABLE",
        message: "Authentication infrastructure is temporarily unavailable.",
      }));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="interface-persistence-error"]')
        ?.textContent,
    ).toContain("Interface preferences could not sync");
    const openStudio = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Open Interface Studio",
    );
    expect(openStudio).toBeDefined();
    act(() => openStudio?.click());
    expect(current().interfaceStudioOpen).toBe(true);
  });

  it("still captures a noncanonical middleware-shaped 401", async () => {
    mocks.fetch.mockResolvedValueOnce(response(401, {
      error: "UNAUTHORIZED",
      message: "Sign in required.",
      detail: "unexpected-contract",
    }));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: expect.objectContaining({
        status: 401,
        code: "PROFILE_LOAD_FAILED",
        transport: "route",
        stage: "response-status",
      }),
    });
  });

  it.each([
    [403, {
      error: "MFA_REQUIRED",
      message: "Complete two-factor authentication to continue",
    }],
    [503, {
      error: "AUTH_CONFIGURATION_UNAVAILABLE",
      message: "Authentication assurance could not be verified.",
    }],
    [503, {
      error: "AUTH_ASSURANCE_UNAVAILABLE",
      message: "Authentication assurance could not be verified.",
      detail: "unexpected-contract",
    }],
  ])("captures a noncanonical middleware auth boundary at status %i", async (status, body) => {
    mocks.fetch.mockResolvedValueOnce(response(status, body));

    await renderProvider();
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: expect.objectContaining({
        status,
        code: "PROFILE_LOAD_FAILED",
        transport: "route",
        stage: "response-status",
      }),
    });
  });

  it("recovers from a middleware-owned 503 through a valid sandwich and persists the next edit", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(503, {
        error: "AUTH_ASSURANCE_UNAVAILABLE",
        message: "Authentication assurance could not be verified.",
      }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).not.toHaveBeenCalled();

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");

    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(writes()).toHaveLength(1);
    expect(mocks.capture).not.toHaveBeenCalled();
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
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("resets write-failure dedupe after a new subject completes the sandwich", async () => {
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(502, { error: "UNEXPECTED_A_FAILURE" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(response(502, { error: "UNEXPECTED_B_FAILURE" }));

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);
    expect(mocks.capture).toHaveBeenCalledTimes(1);

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");

    act(() => current().setTheme("slate"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      tags: expect.objectContaining({
        operation: "save",
        code: "PROFILE_SAVE_FAILED",
        transport: "route",
        stage: "response-status",
      }),
    }));
  });

  it("retires an active write before full navigation rejects it", async () => {
    const pendingWrite = deferred<unknown>();
    let writeSignal: AbortSignal | null | undefined;
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        writeSignal = init.signal;
        return pendingWrite.promise;
      });

    await renderProvider();
    act(() => current().setTheme("light"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writeSignal?.aborted).toBe(false);

    act(() => window.dispatchEvent(new Event("beforeunload")));
    expect(writeSignal?.aborted).toBe(true);
    pendingWrite.reject(new Error("navigation interrupted preference write"));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
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
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
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
    act(() => vi.advanceTimersByTime(20));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          status: 503,
          code: "PROFILE_LOAD_FAILED",
          transport: "direct",
          stage: "rls",
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

    act(() => mocks.authCallback?.("TOKEN_REFRESHED"));
    await act(flushMicrotasks);
    expect(current().interfacePersistence).toBe("synced");
    act(() => current().setTheme("dim"));
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
    expect(current().interfacePersistence).toBe("synced");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
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

  it("binds a delayed pre-S1 edit to A before an S2 mismatch restarts on B", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(current().theme).toBe("light");
    expect(reads()).toHaveLength(4);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps a pre-S1 lifecycle edit local until the verified account explicitly accepts it", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    expect(current().interfacePersistence).toBe("local");
    expect(writes()).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "These interface changes are local only",
    );

    const apply = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply to this account",
    );
    expect(apply).toBeDefined();
    act(() => apply?.click());
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    expect(current().interfacePersistence).toBe("synced");
  });

  it("does not transfer a pre-S1 lifecycle edit to B and restores B on explicit discard", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    expect(current().interfacePersistence).toBe("local");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    const discard = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard local changes",
    );
    expect(discard).toBeDefined();
    act(() => discard?.click());

    expect(current().theme).toBe("light");
    expect(current().interfacePersistence).toBe("synced");
    expect(writes()).toHaveLength(0);
  });

  it("discards only orphaned fields without erasing a later A-bound settings draft", async () => {
    const pendingInitialS1 = deferred<unknown>();
    const pendingARead = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingInitialS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, {
        theme: "dark",
        settings: SETTINGS_A,
      }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead.mockImplementationOnce(() => pendingARead.promise);

    await renderProvider();
    act(() => current().setTheme("slate"));
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);

    act(() => current().setInterfaceSettings(SETTINGS_B));
    pendingARead.resolve(preferenceRow());
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    expect(current().interfacePersistence).toBe("local");
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.envelope.theme).toBe("dark");
    expect(bodyWritten.envelope.settings).toEqual(SETTINGS_B);

    const discard = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard local changes",
    );
    act(() => discard?.click());

    expect(current().theme).toBe("dark");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    expect(current().interfacePersistence).toBe("synced");
  });

  it("prunes a fully shadowed orphan when a later A-bound edit owns the same field", async () => {
    const pendingInitialS1 = deferred<unknown>();
    const pendingARead = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingInitialS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead.mockImplementationOnce(() => pendingARead.promise);

    await renderProvider();
    act(() => current().setTheme("slate"));
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);

    act(() => current().setTheme("dim"));
    pendingARead.resolve(preferenceRow());
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().theme).toBe("dim");
    expect(current().interfacePersistence).toBe("synced");
    expect(
      document.querySelector('[data-testid="orphaned-interface-preferences"]'),
    ).toBeNull();
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.envelope.theme).toBe("dim");
  });

  it("preserves an A-bound mismatch draft across B and persists it once when A later returns", async () => {
    const pendingS1 = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);

    expect(current().theme).toBe("light");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(current().interfacePersistence).toBe("synced");
    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(1);
  });

  it("consolidates an established A draft before an auth-event lifecycle restart on B", async () => {
    const pendingS1 = deferred<unknown>();
    const staleARead = deferred<unknown>();
    mocks.fetch
      .mockImplementationOnce(() => pendingS1.promise)
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, { theme: "light" }))
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_A, { theme: "dark" }))
      .mockResolvedValueOnce(response(200, { ok: true, subject: SUBJECT_A }));
    mocks.rlsRead.mockImplementationOnce(() => staleARead.promise);

    await renderProvider();
    act(() => current().setTheme("slate"));
    pendingS1.resolve(readResponse(SUBJECT_A));
    await act(flushMicrotasks);
    expect(mocks.from).toHaveBeenCalledTimes(1);

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("light");
    expect(current().interfacePersistence).toBe("synced");
    staleARead.resolve(preferenceRow());
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);
    expect(writes()).toHaveLength(0);

    act(() => mocks.authCallback?.("SIGNED_IN"));
    await act(flushMicrotasks);
    expect(current().theme).toBe("slate");
    act(() => vi.advanceTimersByTime(450));
    await act(flushMicrotasks);

    expect(writes()).toHaveLength(1);
    const bodyWritten = JSON.parse(
      String((writes()[0]?.[1] as RequestInit).body),
    );
    expect(bodyWritten.subject).toBe(SUBJECT_A);
    expect(bodyWritten.envelope.theme).toBe("slate");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("does not promote an edit made after initial S1 when S2 changes to B", async () => {
    const pendingARead = deferred<unknown>();
    mocks.fetch
      .mockResolvedValueOnce(readResponse(SUBJECT_A))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B))
      .mockResolvedValueOnce(readResponse(SUBJECT_B, {
        theme: "slate",
        settings: SETTINGS_B,
      }));
    mocks.rlsRead.mockImplementationOnce(() => pendingARead.promise);

    await renderProvider();
    act(() => current().setTheme("light"));
    pendingARead.resolve(preferenceRow({
      theme: "dark",
      settings: SETTINGS_A,
    }));
    await act(flushMicrotasks);

    expect(current().theme).toBe("slate");
    expect(current().interfaceSettings).toEqual(SETTINGS_B);
    expect(current().interfacePersistence).toBe("synced");
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
