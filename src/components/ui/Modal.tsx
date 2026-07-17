"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  motion?: "standard" | "reduced";
  busy?: boolean;
};

const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "[href]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function visibleFocusable(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((node) => (
      !node.hidden
      && !node.matches(":disabled")
      && node.getAttribute("aria-hidden") !== "true"
      && node.getAttribute("aria-disabled") !== "true"
      && node.tabIndex >= 0
      && getComputedStyle(node).display !== "none"
      && getComputedStyle(node).visibility !== "hidden"
    ));
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  motion = "standard",
  busy = false,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, open, onClose]);

  // Focus trap
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    const overlay = overlayRef.current;
    if (!el || !overlay) return;
    const trigger = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const background = [...document.body.children]
      .filter((node): node is HTMLElement => (
        node instanceof HTMLElement && node !== overlay
      ))
      .map((node) => ({ node, inert: node.inert }));
    for (const { node } of background) node.inert = true;
    const focusInside = () => {
      (visibleFocusable(el)[0] ?? el).focus({ preventScroll: true });
    };
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = visibleFocusable(el);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      } else if (
        e.shiftKey
        && (document.activeElement === first || !el.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey
        && (document.activeElement === last || !el.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || !el.contains(event.target)) {
        focusInside();
      }
    };
    document.addEventListener("keydown", trap, true);
    document.addEventListener("focusin", containFocus, true);
    focusInside();
    return () => {
      document.removeEventListener("keydown", trap, true);
      document.removeEventListener("focusin", containFocus, true);
      for (const item of background) item.node.inert = item.inert;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  // A pending action can disable the control that currently owns focus. Keep
  // focus in a usable control, or on the dialog itself when every control is
  // disabled, as soon as the busy state changes.
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    const nodes = visibleFocusable(el);
    const active = document.activeElement;
    if (active instanceof HTMLElement && nodes.includes(active)) return;
    (nodes[0] ?? el).focus({ preventScroll: true });
  }, [busy, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "rgba(0,0,0,0.62)",
        backdropFilter: "blur(4px)",
        animation: motion === "reduced" ? "none" : "modal-bg-in 0.18s ease",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="card w-full max-w-md border border-[var(--line-strong)] shadow-2xl"
        style={{
          animation: motion === "reduced"
            ? "none"
            : "modal-card-in 0.22s cubic-bezier(.2,.8,.2,1)",
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2
            id={titleId}
            className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]"
          >
            {title}
          </h2>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </Button>
        </div>
        <div>{children}</div>
        {footer && (
          <div className="mt-4 flex justify-end gap-2 border-t border-[var(--line)] pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
