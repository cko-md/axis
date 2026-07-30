// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShellProfileContext,
  type AccountState,
  type ProfileSaveState,
  type ShellProfileContextValue,
} from "./ShellProfileContext";

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
  Topbar: ({
    accountState,
    profileSaveState,
    hasPendingProfileChanges,
  }: {
    accountState: AccountState;
    profileSaveState: ProfileSaveState;
    hasPendingProfileChanges: boolean;
  }) => (
    <div>
      {`topbar:${accountState}:${profileSaveState}:${hasPendingProfileChanges}`}
    </div>
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

const profileValue: ShellProfileContextValue = {
  state: "ready",
  profile: {
    display_name: "Name",
    role_title: "Role",
    bio: null,
    avatar_url: null,
    email: null,
  },
  draft: {
    name: "Pending Name",
    role: "Role",
    bio: "",
    photo: "",
  },
  saveState: "pending",
  hasPendingChanges: true,
  scheduleProfileSave: vi.fn(),
  retryProfileSave: vi.fn(),
};

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
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
  it("passes root-owned profile state to Topbar while the Sidebar is collapsed", () => {
    act(() => {
      root?.render(
        <ShellProfileContext.Provider value={profileValue}>
          <AppShell section="Daily" page="Command">
            <div>Content</div>
          </AppShell>
        </ShellProfileContext.Provider>,
      );
    });

    expect(container.textContent).toContain("sidebar:collapsed");
    expect(container.textContent).toContain("topbar:ready:pending:true");
  });
});
