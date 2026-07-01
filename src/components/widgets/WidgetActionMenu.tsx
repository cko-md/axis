"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { WidgetAction } from "@/lib/widgets/types";

type ActionHandlers = {
  refresh?: () => void;
  open?: () => void;
  configure?: () => void;
  hide?: () => void;
  route?: (href: string, action: WidgetAction) => void;
};

type Props = {
  actions: WidgetAction[];
  handlers?: ActionHandlers;
  align?: "start" | "end";
  label?: string;
  className?: string;
};

export const WIDGET_ACTION_KIND_LABELS: Record<WidgetAction["kind"], string> = {
  refresh: "Refresh",
  navigate: "Open",
  "open-drawer": "Open",
  create: "Open",
  configure: "Configure",
  hide: "Hide",
};

export function widgetActionLabel(action: WidgetAction) {
  return action.label || WIDGET_ACTION_KIND_LABELS[action.kind];
}

export function nextEnabledActionIndex(actions: WidgetAction[], currentIndex: number, direction: 1 | -1) {
  const enabledActions = actions.map((action, index) => ({ action, index })).filter(({ action }) => !action.disabledReason);
  if (enabledActions.length === 0) return -1;
  const currentEnabledIndex = enabledActions.findIndex(({ index }) => index === currentIndex);
  const nextIndex = currentEnabledIndex === -1
    ? direction === 1 ? 0 : enabledActions.length - 1
    : (currentEnabledIndex + direction + enabledActions.length) % enabledActions.length;
  return enabledActions[nextIndex]?.index ?? -1;
}

export function WidgetActionMenu({
  actions,
  handlers,
  align = "end",
  label = "Widget actions",
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const firstEnabled = nextEnabledActionIndex(actions, -1, 1);
      itemRefs.current[firstEnabled]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [actions, open]);

  const close = () => setOpen(false);

  const execute = (action: WidgetAction) => {
    if (action.disabledReason) return;
    if (action.kind === "refresh") handlers?.refresh?.();
    if (action.kind === "open-drawer") handlers?.open?.();
    if (action.kind === "configure") handlers?.configure?.();
    if (action.kind === "hide") handlers?.hide?.();
    if ((action.kind === "navigate" || action.kind === "create") && action.href) {
      handlers?.route?.(action.href, action);
    }
    close();
  };

  const handleRootClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      rootRef.current?.querySelector<HTMLButtonElement>(".widget-action-trigger")?.focus();
      return;
    }
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = itemRefs.current.findIndex((node) => node === document.activeElement);
      const nextIndex = nextEnabledActionIndex(actions, currentIndex, event.key === "ArrowDown" ? 1 : -1);
      itemRefs.current[nextIndex]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex = nextEnabledActionIndex(actions, event.key === "Home" ? -1 : actions.length, event.key === "Home" ? 1 : -1);
      itemRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`widget-action-menu widget-action-menu-${align} ${className}`.trim()}
      onClick={handleRootClick}
      onKeyDown={handleRootKeyDown}
    >
      <button
        type="button"
        className="widget-action-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">...</span>
      </button>
      {open ? (
        <div id={menuId} className="widget-action-popover" role="menu" aria-orientation="vertical">
          {actions.map((action, index) => (
            <button
              key={action.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              className="widget-action-item"
              aria-label={widgetActionLabel(action)}
              aria-disabled={Boolean(action.disabledReason)}
              disabled={Boolean(action.disabledReason)}
              title={action.disabledReason}
              onClick={() => execute(action)}
            >
              <span>{widgetActionLabel(action)}</span>
              {action.href ? <span className="widget-action-route">{action.href}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
