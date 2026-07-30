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
  function setup() {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    }));
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    const render = (open: boolean, strict = false) => {
      const widget = <SearchWidget open={open} onClose={vi.fn()} />;
      act(() => root?.render(strict ? <React.StrictMode>{widget}</React.StrictMode> : widget));
    };
    const input = () => container.querySelector<HTMLInputElement>("[role=combobox]");
    const release = (frame: number) => {
      const callback = callbacks.get(frame);
      if (!callback) throw new Error(`No queued animation frame ${frame}.`);
      act(() => callback(0));
    };

    return { callbacks, cancelAnimationFrame, container, input, release, render, trigger };
  }

  it("restores normal close focus to the invoker", () => {
    const { input, release, render, trigger } = setup();
    render(true);
    expect(document.activeElement).toBe(input());

    render(false);
    release(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("retains the original invoker through rapid reopen and final close", () => {
    const { cancelAnimationFrame, input, release, render, trigger } = setup();
    render(true);
    render(false); // frame A
    render(true);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(input());

    render(false); // frame B
    release(1); // An already-dispatched stale A must not disown B.
    release(2);
    expect(document.activeElement).toBe(trigger);
  });

  it("does not recapture the input as its invoker during StrictMode replay", () => {
    const { input, release, render, trigger } = setup();
    render(true, true);
    expect(document.activeElement).toBe(input());

    render(false, true);
    release(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("drops a disconnected restore target and captures the next valid invoker", () => {
    const { release, render, trigger } = setup();
    render(true);
    render(false); // frame A captures trigger while it is connected.
    trigger.remove();
    release(1);

    const nextTrigger = document.createElement("button");
    document.body.append(nextTrigger);
    nextTrigger.focus();
    render(true);
    render(false); // frame B must use the new connected trigger.
    release(2);
    expect(document.activeElement).toBe(nextTrigger);
  });

  it("does not let a stale frame disown a newer restore before unmount", () => {
    const { cancelAnimationFrame, release, render } = setup();
    const sentinel = document.createElement("button");
    document.body.append(sentinel);

    render(true);
    render(false); // frame A
    render(true);
    render(false); // frame B
    release(1); // A must leave B as the active restoration owner.

    act(() => root?.unmount());
    root = null;
    sentinel.focus();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    release(2); // A canceled-but-released B cannot steal focus post-unmount.
    expect(document.activeElement).toBe(sentinel);
  });
});
