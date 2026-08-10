import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureRouteError: vi.fn() }));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

import { resolveRouteIdentity } from "./routeIdentity";

function client(result: { data: { user: { id: string } | null }; error: unknown }) {
  return { auth: { getUser: vi.fn(async () => result) } };
}

describe("financial route identity boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    null,
    { name: "AuthSessionMissingError", status: 400 },
    { status: 401 },
    { code: "invalid_refresh_token" },
  ])("keeps an expected signed-out state quiet", async (error) => {
    await expect(resolveRouteIdentity(
      () => client({ data: { user: null }, error }),
      { route: "/api/fund/test", area: "fund" },
    )).resolves.toMatchObject({ ok: false, status: 401, code: "UNAUTHORIZED" });
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it.each(["client", "lookup", "result"] as const)(
    "captures an operational auth %s failure",
    async (mode) => {
      const create = mode === "client"
        ? () => { throw new Error("unavailable"); }
        : () => ({
            auth: {
              getUser: mode === "lookup"
                ? vi.fn(async () => { throw new Error("unavailable"); })
                : vi.fn(async () => ({ data: { user: null }, error: { status: 503 } })),
            },
          });

      await expect(resolveRouteIdentity(
        create,
        { route: "/api/fund/test", area: "fund" },
      )).resolves.toMatchObject({ ok: false, status: 503, code: "AUTH_UNAVAILABLE" });
      expect(mocks.captureRouteError).toHaveBeenCalledTimes(1);
    },
  );
});
