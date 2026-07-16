"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

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
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial = el?.querySelector<HTMLElement>(sel);
    initial?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = [...(el?.querySelectorAll<HTMLElement>(sel) ?? [])]
        .filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true");
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus();
      }
    };
    el?.addEventListener("keydown", trap);
    return () => {
      el?.removeEventListener("keydown", trap);
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        className="modal-surface card w-full max-w-md border border-[var(--line-strong)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2
            id={titleId}
            className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]"
          >
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close dialog">
            <X size={16} strokeWidth={1.6} aria-hidden />
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
