// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "./ShellProfileContext";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next/dynamic", () => ({
  default: () => function DynamicStub() {
    return null;
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/command" }));
vi.mock("@/components/nav/Sidebar", () => ({
  Sidebar: ({ collapsed }: { collapsed: boolean }) => (
    <div>{`sidebar:${collapsed ? "collapsed" : "open"}`}</div>
  ),
}));
vi.mock("@/components/nav/Topbar", () => ({
  Topbar: ({ accountState }: { accountState: AccountState }) => (
    <div>{`topbar:${accountState}`}</div>
  ),
}));
vi.mock("@/components/spotify/SpotifyProvider", () => ({
  SpotifyProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/ui/axis/AxisAtmosphere", () => ({
  AxisAtmosphere: () => null,
}));
vi.mock("@/components/workspace/WorkspaceProvider", () => ({
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useWorkspace: () => ({ hasWorkspace: false }),
}));
vi.mock("@/components/workspace/WorkspaceSurface", () => ({
  WorkspaceSurface: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/lib/store/nav", () => ({ ALL_NAV_ITEMS: [] }));

import { AppShell } from "./AppShell";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("matchMedia", vi.fn());
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 700,
  });
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AppShell profile ownership", () => {
  it("keeps provider state available to Topbar while the Sidebar is collapsed", async () => {
    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({
        display_name: "Name",
        role_title: "Role",
        bio: null,
        avatar_url: null,
        email: null,
      }),
    });

    act(() => {
      root?.render(
        <AppShell section="Daily" page="Command">
          <div>Content</div>
        </AppShell>,
      );
    });
    await act(flush);

    expect(container.textContent).toContain("sidebar:collapsed");
    expect(container.textContent).toContain("topbar:ready");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/auth/profile",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
