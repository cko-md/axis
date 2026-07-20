import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  optionalEnv: vi.fn(),
  admin: vi.fn(),
  scanPlatformForUser: vi.fn(),
  scanForObjectives: vi.fn(),
  scanForNewPapers: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ optionalEnv: (k: string) => mocks.optionalEnv(k) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin() }));
vi.mock("@/lib/signals/scan", () => ({
  scanPlatformForUser: (...a: unknown[]) => mocks.scanPlatformForUser(...a),
}));
vi.mock("@/lib/objectives/scan", () => ({
  scanForObjectives: (...a: unknown[]) => mocks.scanForObjectives(...a),
}));
vi.mock("@/lib/literature/watch", () => ({
  scanForNewPapers: (...a: unknown[]) => mocks.scanForNewPapers(...a),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mocks.captureException(...a),
  captureMessage: (...a: unknown[]) => mocks.captureMessage(...a),
}));

import { POST } from "./route";

const SECRET = "sweep-secret";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Chainable + awaitable supabase query double that resolves to `result`. */
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "not", "gte", "contains", "order", "limit"]) {
    chain[m] = () => chain;
  }
  chain.insert = async () => ({ error: null });
  chain.maybeSingle = async () => result;
  // Thenable so `await supabase.from(...).select()...` resolves anywhere.
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

function adminClient(userIds: string[] = [USER_ID]) {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users: userIds.map((id) => ({ id })) }, error: null }) } },
    // Every table read the sweep performs (notes, conferences, signals) is
    // benign here so only the objectives step under test drives the outcome.
    from: () => query({ data: [], error: null }),
  };
}

function request() {
  return new NextRequest("http://axis.test/api/cron/intelligence-sweep", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

describe("intelligence-sweep objectives classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.optionalEnv.mockImplementation((k: string) => (k === "MAKE_SWEEP_SECRET" ? SECRET : undefined));
    mocks.admin.mockReturnValue(adminClient());
    mocks.scanPlatformForUser.mockResolvedValue({ created: 0 });
    mocks.scanForNewPapers.mockResolvedValue([]);
  });

  it("treats insufficient-activity as a benign skip, not a failure or error", async () => {
    mocks.scanForObjectives.mockResolvedValue({
      results: [],
      error: "Not enough recent activity to scan.",
      code: "insufficient-activity",
    });

    const body = await (await POST(request())).json();

    expect(body.ok).toBe(true);
    expect(body.failures).toBe(0);
    expect(body.results[USER_ID].objectives_scan).toEqual({ suggested: 0, inserted: 0, skipped: "insufficient-activity" });
    // The bug that fired issue 1D: this must produce NO Sentry error at all.
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it("captures a transient AI failure at warning with the real cause, without failing the sweep", async () => {
    const cause = new Error("provider 529 overloaded");
    mocks.scanForObjectives.mockResolvedValue({
      results: [],
      error: "AI scan is unavailable right now. Try again shortly.",
      code: "ai-unavailable",
      cause,
    });

    const body = await (await POST(request())).json();

    expect(body.ok).toBe(true);
    expect(body.failures).toBe(0);
    expect(body.results[USER_ID].objectives_scan).toEqual({ suggested: 0, inserted: 0, skipped: "ai-unavailable" });
    // The REAL error, at warning level — debuggable, and it does not escalate.
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [reported, ctx] = mocks.captureException.mock.calls[0];
    expect(reported).toBe(cause);
    expect((ctx as { level: string }).level).toBe("warning");
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it("circuit-breaks after the first ai-unavailable: no repeat call across users", async () => {
    // The core reliability fix. On a provider outage, one slow-failing AI call
    // PER user is what accumulated into the Vercel timeout / 502 / Make retry
    // storm. After the first ai-unavailable, the remaining users must skip the
    // call entirely — and the warning must fire exactly once, not per user.
    mocks.admin.mockReturnValue(adminClient(["u1", "u2", "u3"]));
    mocks.scanForObjectives.mockResolvedValue({
      results: [],
      error: "AI scan is unavailable right now. Try again shortly.",
      code: "ai-unavailable",
      cause: new Error("provider 503"),
    });

    const body = await (await POST(request())).json();

    // Called for the first user only; the other two short-circuit.
    expect(mocks.scanForObjectives).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    for (const u of ["u1", "u2", "u3"]) {
      expect(body.results[u].objectives_scan).toEqual({ suggested: 0, inserted: 0, skipped: "ai-unavailable" });
    }
    expect(body.ok).toBe(true);
    expect(body.failures).toBe(0);
  });

  it("still hard-errors a genuine data-load failure", async () => {
    mocks.scanForObjectives.mockResolvedValue({
      results: [],
      error: "Could not load platform data for scan.",
      code: "data-load-failed",
    });

    const body = await (await POST(request())).json();

    expect(body.ok).toBe(false);
    expect(body.failures).toBe(1);
    expect(body.results[USER_ID].objectives_scan).toEqual({ error: "SWEEP_OPERATION_FAILED", operation: "objectives_scan" });
  });

  it("captures the real exception when a scan step throws", async () => {
    const boom = new Error("platform scan exploded");
    mocks.scanPlatformForUser.mockRejectedValue(boom);
    mocks.scanForObjectives.mockResolvedValue({ results: [], error: undefined });

    const body = await (await POST(request())).json();

    expect(body.failures).toBeGreaterThanOrEqual(1);
    // The stack-bearing exception, not a contentless captureMessage.
    expect(mocks.captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ level: "error" }));
  });
});
