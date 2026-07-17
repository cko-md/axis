import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PANE_WIDTH_BPS,
  MAX_PANE_WIDTH_BPS,
  MIN_PANE_WIDTH_BPS,
} from "@/lib/workspace/types";
import { PaneResizer, paneWidthForKey } from "./PaneResizer";

describe("PaneResizer", () => {
  it("maps keyboard controls to clamped, deterministic pane widths", () => {
    expect(paneWidthForKey("ArrowLeft", DEFAULT_PANE_WIDTH_BPS)).toBe(
      DEFAULT_PANE_WIDTH_BPS + 100,
    );
    expect(paneWidthForKey("ArrowRight", DEFAULT_PANE_WIDTH_BPS, true)).toBe(
      DEFAULT_PANE_WIDTH_BPS - 500,
    );
    expect(paneWidthForKey("Home", DEFAULT_PANE_WIDTH_BPS)).toBe(MIN_PANE_WIDTH_BPS);
    expect(paneWidthForKey("End", DEFAULT_PANE_WIDTH_BPS)).toBe(MAX_PANE_WIDTH_BPS);
    expect(paneWidthForKey("Enter", MIN_PANE_WIDTH_BPS)).toBe(DEFAULT_PANE_WIDTH_BPS);
    expect(paneWidthForKey("Escape", DEFAULT_PANE_WIDTH_BPS)).toBeNull();
    expect(paneWidthForKey("ArrowLeft", MAX_PANE_WIDTH_BPS)).toBe(MAX_PANE_WIDTH_BPS);
  });

  it("renders an operable, value-labelled separator", () => {
    const html = renderToStaticMarkup(
      <PaneResizer
        paneId="pane-1"
        paneLabel="Note"
        widthBps={DEFAULT_PANE_WIDTH_BPS}
        onPreview={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize Note pane"');
    expect(html).toContain('aria-valuenow="36"');
    expect(html).toContain('aria-valuetext="36 percent width"');
    expect(html).toContain('tabindex="0"');
  });
});

