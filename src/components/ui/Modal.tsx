"use client";

import { useEffect, type ReactNode } from "react";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="card w-full max-w-md border border-[var(--line-strong)] shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="modal-title" className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]">
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div>{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2 border-t border-[var(--line)] pt-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
