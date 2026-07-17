"use client";

import React from "react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  DEFAULT_PANE_WIDTH_BPS,
  MAX_PANE_WIDTH_BPS,
  MIN_PANE_WIDTH_BPS,
} from "@/lib/workspace/types";
import { clampPaneWidthBps } from "@/lib/workspace/state";
import styles from "./Workspace.module.css";

const KEYBOARD_STEP_BPS = 100;
const KEYBOARD_LARGE_STEP_BPS = 500;

export function paneWidthForKey(
  key: string,
  currentWidthBps: number,
  shiftKey = false,
  maxWidthBps = MAX_PANE_WIDTH_BPS,
): number | null {
  const step = shiftKey ? KEYBOARD_LARGE_STEP_BPS : KEYBOARD_STEP_BPS;
  switch (key) {
    // The separator is immediately to the left of the evidence pane, so moving
    // it left grows the pane and moving it right shrinks the pane.
    case "ArrowLeft":
    case "ArrowUp":
      return clampPaneWidthBps(currentWidthBps + step, maxWidthBps);
    case "ArrowRight":
    case "ArrowDown":
      return clampPaneWidthBps(currentWidthBps - step, maxWidthBps);
    case "Home":
      return MIN_PANE_WIDTH_BPS;
    case "End":
      return maxWidthBps;
    case "Enter":
      return DEFAULT_PANE_WIDTH_BPS;
    default:
      return null;
  }
}

type Props = {
  paneId: string;
  paneLabel: string;
  widthBps: number;
  maxWidthBps?: number;
  onPreview: (widthBps: number | null) => void;
  onCommit: (widthBps: number) => void;
};

type DragState = {
  pointerId: number;
  startX: number;
  startWidthBps: number;
  containerWidth: number;
  previewWidthBps: number;
};

export function PaneResizer({
  paneId,
  paneLabel,
  widthBps,
  maxWidthBps = MAX_PANE_WIDTH_BPS,
  onPreview,
  onCommit,
}: Props) {
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaBps = ((drag.startX - event.clientX) / drag.containerWidth) * 10_000;
    const previewWidthBps = clampPaneWidthBps(
      drag.startWidthBps + deltaBps,
      maxWidthBps,
    );
    drag.previewWidthBps = previewWidthBps;
    onPreview(previewWidthBps);
  };

  const finishPointer = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    onPreview(null);
    if (commit) onCommit(drag.previewWidthBps);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextWidth = paneWidthForKey(
      event.key,
      widthBps,
      event.shiftKey,
      maxWidthBps,
    );
    if (nextWidth === null) return;
    event.preventDefault();
    onCommit(nextWidth);
  };

  return (
    <div
      id={`workspace-resizer-${paneId}`}
      className={styles.resizer}
      role="separator"
      aria-label={`Resize ${paneLabel} pane`}
      aria-controls={`workspace-pane-${paneId}`}
      aria-orientation="vertical"
      aria-valuemin={MIN_PANE_WIDTH_BPS / 100}
      aria-valuemax={maxWidthBps / 100}
      aria-valuenow={Math.round(widthBps / 100)}
      aria-valuetext={`${Math.round(widthBps / 100)} percent width`}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const containerWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
        if (containerWidth <= 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidthBps: widthBps,
          containerWidth,
          previewWidthBps: widthBps,
        };
        setDragging(true);
      }}
      onPointerMove={updateFromPointer}
      onPointerUp={(event) => {
        updateFromPointer(event);
        finishPointer(event, true);
      }}
      onPointerCancel={(event) => finishPointer(event, false)}
      onLostPointerCapture={() => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        onPreview(null);
      }}
    />
  );
}
