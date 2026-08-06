import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

const mocks = vi.hoisted(() => ({
  captureRouteError: vi.fn(),
  createClient: vi.fn(),
  getUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/components/landing/LandingPublic", () => ({
  LandingPublic: () => null,
}));

import HomePage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
});

describe("public home authentication probe", () => {
  it("renders the public landing page and observes missing auth configuration", async () => {
    mocks.createClient.mockRejectedValueOnce(new Error("missing configuration"));

    await expect(HomePage()).resolves.toMatchObject({ type: expect.any(Function) });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "/",
        operation: "resolve_optional_session",
        status: 503,
        code: "AUTH_CONFIGURATION_UNAVAILABLE",
      }),
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("renders publicly and observes an unexpected authentication backend error", async () => {
    const error = new Error("backend unavailable");
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error });

    await HomePage();
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ code: "AUTH_BACKEND_UNAVAILABLE" }),
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("treats an exact missing-session result as an ordinary signed-out visit", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: "AuthSessionMissingError", status: 400 },
    });

    await HomePage();
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("never trusts user data returned alongside an authentication error", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: "untrusted_user" } },
      error: new Error("contradictory auth response"),
    });

    await HomePage();
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "AUTH_BACKEND_UNAVAILABLE" }),
    );
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("preserves the authenticated redirect without catching the redirect control flow", async () => {
    const redirectSignal = new Error("NEXT_REDIRECT");
    mocks.redirect.mockImplementationOnce(() => {
      throw redirectSignal;
    });
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: "user_1" } },
      error: null,
    });

    await expect(HomePage()).rejects.toBe(redirectSignal);
    expect(mocks.redirect).toHaveBeenCalledWith("/command");
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });
});
