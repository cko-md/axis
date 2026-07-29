// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    currentPaneEntity: null,
    hrefWithWorkspace: (href: string) => href,
    openEntity: () => ({ ok: true }),
  }),
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

import { SearchWidget } from "./SearchWidget";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => {
  // The production build uses Next's automatic JSX runtime; Vitest's local
  // JSX transform is classic for this isolated DOM regression harness.
  vi.stubGlobal("React", React);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("SearchWidget focus restoration", () => {
  it("keeps the combobox focused when reopened before close restoration runs", () => {
    let pendingRestore: FrameRequestCallback | null = null;
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      pendingRestore = callback;
      return 17;
    }));
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => root?.render(<SearchWidget open onClose={vi.fn()} />));
    const input = container.querySelector<HTMLInputElement>("[role=combobox]");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    act(() => root?.render(<SearchWidget open={false} onClose={vi.fn()} />));
    expect(pendingRestore).not.toBeNull();

    act(() => root?.render(<SearchWidget open onClose={vi.fn()} />));
    const reopenedInput = container.querySelector<HTMLInputElement>("[role=combobox]");
    expect(reopenedInput).not.toBeNull();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
    expect(document.activeElement).toBe(reopenedInput);

    // Browsers suppress canceled frames, but make the stale callback run here
    // to prove a callback already queued for dispatch still cannot steal focus.
    if (!pendingRestore) throw new Error("Expected close to queue focus restoration.");
    act(() => pendingRestore?.(0));
    expect(document.activeElement).toBe(reopenedInput);
  });
});
