"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import type { WidgetStatus } from "@/lib/widgets/types";
import { WidgetStatusBadge } from "@/components/widgets/WidgetStatusBadge";
import { WIDGET_MOTION, widgetMotionMode } from "@/components/widgets/widgetMotion";
import { DetailPanelSections, detailPanelSectionTitleId, type DetailPanelSectionConfig } from "@/components/ui/DetailPanel";

export type WidgetDetailSection = DetailPanelSectionConfig;

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  description?: ReactNode;
  status: WidgetStatus;
  source?: string;
  updatedAt?: string;
  primaryActionSlot?: ReactNode;
  sections?: WidgetDetailSection[];
  children?: ReactNode;
  footerSlot?: ReactNode;
};

export function formatWidgetDetailUpdatedAt(updatedAt?: string) {
  if (!updatedAt) return null;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function widgetDetailSectionTitleId(sectionId: string) {
  return detailPanelSectionTitleId(sectionId, "widget-detail-section");
}

export function WidgetDetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  description,
  status,
  source,
  updatedAt,
  primaryActionSlot,
  sections,
  children,
  footerSlot,
}: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const updated = formatWidgetDetailUpdatedAt(updatedAt);
  const reduceMotion = useReducedMotion();
  const motionMode = widgetMotionMode(reduceMotion);
  const hasDescription = Boolean(description || subtitle);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const focusable = drawerRef.current?.querySelector<HTMLElement>(
        'button,input,textarea,select,[href],[tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'button,input,textarea,select,[href],[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((node) => !node.hasAttribute("disabled"));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <motion.div
      className="widget-drawer-backdrop"
      data-motion={motionMode}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      initial={motionMode === "reduced" ? false : { opacity: 0 }}
      animate={motionMode === "reduced" ? undefined : { opacity: 1 }}
      transition={WIDGET_MOTION.drawerBackdrop}
    >
      <motion.aside
        ref={drawerRef}
        className="widget-detail-drawer"
        data-motion={motionMode}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasDescription ? descriptionId : undefined}
        initial={motionMode === "reduced" ? false : { opacity: 0.88, x: 22 }}
        animate={motionMode === "reduced" ? undefined : { opacity: 1, x: 0 }}
        transition={WIDGET_MOTION.drawerPanel}
      >
        <header className="widget-detail-header">
          <div className="widget-detail-heading">
            <div className="widget-detail-kicker">
              <WidgetStatusBadge status={status} />
              {source ? <span>{source}</span> : null}
            </div>
            <h2 id={titleId}>{title}</h2>
            {subtitle || description ? (
              <div id={descriptionId} className="widget-detail-subtitle">
                {subtitle}
                {description ? <div className="widget-detail-description">{description}</div> : null}
              </div>
            ) : null}
            {updated ? <div className="widget-detail-updated">Updated {updated}</div> : null}
          </div>
          <button type="button" className="widget-detail-close" onClick={onClose} aria-label="Close widget details">
            x
          </button>
        </header>
        {primaryActionSlot ? <div className="widget-detail-primary">{primaryActionSlot}</div> : null}
        <div className="widget-detail-body">
          {sections?.length ? <DetailPanelSections sections={sections} /> : null}
          {children}
        </div>
        {footerSlot ? <footer className="widget-detail-footer">{footerSlot}</footer> : null}
      </motion.aside>
    </motion.div>,
    document.body,
  );
}
