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

const ACTION_KIND_LABELS: Record<WidgetAction["kind"], string> = {
  refresh: "Refresh",
  navigate: "Open",
  "open-drawer": "Open",
  create: "Open",
  configure: "Configure",
  hide: "Hide",
};

function actionFallbackLabel(action: WidgetAction) {
  return action.label || ACTION_KIND_LABELS[action.kind];
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

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

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
        <div id={menuId} className="widget-action-popover" role="menu">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className="widget-action-item"
              disabled={Boolean(action.disabledReason)}
              title={action.disabledReason}
              onClick={() => execute(action)}
            >
              <span>{actionFallbackLabel(action)}</span>
              {action.href ? <span className="widget-action-route">{action.href}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
