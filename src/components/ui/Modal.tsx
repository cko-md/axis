"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function Modal({ open, onClose, title, children, footer }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus trap
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    const sel = 'button,input,textarea,select,[href],[tabindex]:not([tabindex="-1"])';
    const nodes = [...(el?.querySelectorAll<HTMLElement>(sel) ?? [])];
    nodes[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus();
      }
    };
    el?.addEventListener("keydown", trap);
    return () => el?.removeEventListener("keydown", trap);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "rgba(0,0,0,0.62)",
        backdropFilter: "blur(4px)",
        animation: "modal-bg-in 0.18s ease",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={dialogRef}
        className="card w-full max-w-md border border-[var(--line-strong)] shadow-2xl"
        style={{ animation: "modal-card-in 0.22s cubic-bezier(.2,.8,.2,1)" }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2
            id="modal-title"
            className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]"
          >
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">✕</Button>
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
