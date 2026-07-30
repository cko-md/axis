// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "@/components/layout/ShellProfileContext";

vi.mock("@/lib/format", () => ({ formatClock: () => "12:00" }));
vi.mock("@/components/theme/ThemeProvider", () => ({
  useTheme: () => ({ openInterfaceStudio: vi.fn() }),
}));
vi.mock("@/lib/hooks/useWebViewer", () => ({
  useWebViewer: () => ({ open: vi.fn() }),
}));

import { Topbar } from "./Topbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
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

describe("Topbar shell profile state", () => {
  it.each([
    ["loading", "Checking sync…"],
    ["ready", "Synced · Supabase"],
    ["signed-out", "Local · Not signed in"],
    ["error", "Sync unavailable"],
  ] satisfies Array<[AccountState, string]>)(
    "maps %s without starting another profile read",
    (accountState, expectedLabel) => {
      act(() => {
        root?.render(
          <Topbar
            section="Daily"
            page="Command"
            accountState={accountState}
            onOpenSearch={vi.fn()}
            onOpenPalette={vi.fn()}
          />,
        );
      });

      expect(container.textContent).toContain(expectedLabel);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
