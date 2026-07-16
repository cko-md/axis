"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { RotateCcw } from "lucide-react";
import { PaneResizer } from "@/components/workspace/PaneResizer";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { Button } from "@/components/ui/Button";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { ENTITY_REGISTRY } from "@/lib/entities/registry";
import {
  MAX_TOTAL_SECONDARY_WIDTH_BPS,
  MIN_PANE_WIDTH_BPS,
  PRIMARY_PANE_ID,
} from "@/lib/workspace/types";
import styles from "./Workspace.module.css";

const COMPACT_WORKSPACE_WIDTH = 880;
const WorkspaceEntityPane = dynamic(
  () =>
    import("@/components/workspace/WorkspaceEntityPane").then((module) => ({
      default: module.WorkspaceEntityPane,
    })),
  {
    ssr: false,
    loading: () => (
      <StatusCallout
        kind="loading"
        title="Loading evidence pane"
        className={styles.paneCallout}
      >
        AXIS is preparing the owner-scoped preview.
      </StatusCallout>
    ),
  },
);

export function WorkspaceSurface({ children }: { children: ReactNode }) {
  const {
    state,
    parseError,
    activePane,
    focusPane,
    resizePane,
    resetWorkspace,
  } = useWorkspace();
  const { toast } = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const [compact, setCompact] = useState(false);
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({});
  const hasSecondaryPanes = state.panes.length > 0;
  const compactPaneIds = [
    PRIMARY_PANE_ID,
    ...state.panes.map((pane) => pane.id),
  ];

  const moveCompactTab = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % compactPaneIds.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + compactPaneIds.length) % compactPaneIds.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = compactPaneIds.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    focusPane(compactPaneIds[nextIndex]);
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-workspace-tab-index="${nextIndex}"]`,
        )
        ?.focus();
    });
  };

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const update = (width: number) => setCompact(width < COMPACT_WORKSPACE_WIDTH);
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasSecondaryPanes]);

  const commitResize = (paneId: string, widthBps: number) => {
    setPreviewWidths((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    const result = resizePane(paneId, widthBps);
    if (!result.ok) toast("The pane width could not be saved to the workspace URL.", "error", "Workspace");
  };

  const invalidStateCallout = parseError ? (
    <StatusCallout
      kind="error"
      title="This workspace link could not be restored"
      className={styles.invalidState}
      actionSlot={
        <Button onClick={resetWorkspace}>
          <RotateCcw size={14} aria-hidden />
          Reset workspace
        </Button>
      }
    >
      The encoded pane state is invalid or from an unsupported version. Reset it to keep this page and start with a clean workspace.
    </StatusCallout>
  ) : null;

  if (!hasSecondaryPanes) {
    return (
      <div ref={rootRef} className={styles.surface}>
        {invalidStateCallout}
        {children}
      </div>
    );
  }

  const primaryPanelId = `workspace-primary-${reactId}`;

  return (
    <div ref={rootRef} className={styles.surface} data-workspace-compact={compact || undefined}>
      {invalidStateCallout}

      {compact ? (
        <div className={styles.tabs} role="tablist" aria-label="Workspace panes">
          <button
            type="button"
            className={styles.tab}
            role="tab"
            aria-selected={state.activePaneId === PRIMARY_PANE_ID}
            aria-controls={primaryPanelId}
            tabIndex={state.activePaneId === PRIMARY_PANE_ID ? 0 : -1}
            data-workspace-tab-index="0"
            onClick={() => focusPane(PRIMARY_PANE_ID)}
            onKeyDown={(event) => moveCompactTab(event, 0)}
          >
            Workspace
          </button>
          {state.panes.map((pane, index) => (
            <button
              type="button"
              className={styles.tab}
              role="tab"
              key={pane.id}
              aria-selected={state.activePaneId === pane.id}
              aria-controls={`workspace-pane-${pane.id}`}
              tabIndex={state.activePaneId === pane.id ? 0 : -1}
              data-workspace-tab-index={index + 1}
              onClick={() => focusPane(pane.id)}
              onKeyDown={(event) => moveCompactTab(event, index + 1)}
            >
              {ENTITY_REGISTRY[pane.current.kind].label}
            </button>
          ))}
        </div>
      ) : null}

      <div className={`${styles.frame} ${compact ? styles.compactFrame : ""}`}>
        <section
          id={primaryPanelId}
          className={`${styles.primaryPane} ${compact && state.activePaneId !== PRIMARY_PANE_ID ? styles.paneHidden : ""}`}
          role={compact ? "tabpanel" : "region"}
          aria-label="Primary workspace"
          hidden={compact && state.activePaneId !== PRIMARY_PANE_ID}
          onPointerDown={() => {
            if (state.activePaneId !== PRIMARY_PANE_ID) focusPane(PRIMARY_PANE_ID);
          }}
        >
          {children}
        </section>

        {state.panes.map((pane) => {
          const visibleWidthBps = previewWidths[pane.id] ?? pane.widthBps;
          const otherPaneWidthBps = state.panes.reduce(
            (total, candidate) =>
              total + (candidate.id === pane.id
                ? 0
                : (previewWidths[candidate.id] ?? candidate.widthBps)),
            0,
          );
          const maxWidthBps = Math.max(
            MIN_PANE_WIDTH_BPS,
            MAX_TOTAL_SECONDARY_WIDTH_BPS - otherPaneWidthBps,
          );
          const descriptor = ENTITY_REGISTRY[pane.current.kind];
          const hidden = compact && state.activePaneId !== pane.id;
          return (
            <div key={pane.id} style={{ display: "contents" }}>
              {!compact ? (
                <PaneResizer
                  paneId={pane.id}
                  paneLabel={descriptor.label}
                  widthBps={visibleWidthBps}
                  maxWidthBps={maxWidthBps}
                  onPreview={(widthBps) => {
                    setPreviewWidths((current) => {
                      if (widthBps === null) {
                        const next = { ...current };
                        delete next[pane.id];
                        return next;
                      }
                      return { ...current, [pane.id]: widthBps };
                    });
                  }}
                  onCommit={(widthBps) => commitResize(pane.id, widthBps)}
                />
              ) : null}
              <section
                id={`workspace-pane-${pane.id}`}
                className={`${styles.secondaryPane} ${hidden ? styles.paneHidden : ""}`}
                role={compact ? "tabpanel" : "region"}
                aria-label={`${descriptor.label} evidence pane`}
                aria-describedby={!compact ? `workspace-resizer-${pane.id}` : undefined}
                hidden={hidden}
                data-active={activePane.id === pane.id}
                style={
                  {
                    "--workspace-pane-width": `${visibleWidthBps / 100}%`,
                  } as CSSProperties
                }
              >
                <WorkspaceEntityPane pane={pane} active={activePane.id === pane.id} />
              </section>
            </div>
          );
        })}
      </div>
    </div>
  );
}
