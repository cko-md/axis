"use client";

import * as Sentry from "@sentry/nextjs";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import {
  buildPaletteCommandSpecs,
  filterPaletteCommandSpecs,
  type PaletteCommandSpec,
  type PaletteGroup,
} from "@/components/nav/command-palette-model";
import { useTheme } from "@/components/theme/ThemeProvider";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";

type Props = {
  open: boolean;
  onClose: () => void;
};

type CommandAvailability =
  | { available: true }
  | { available: false; reason: string };

type PaletteItem = {
  spec: PaletteCommandSpec;
  availability: CommandAvailability;
};

type ParsedResponse =
  | { ok: true; value: unknown }
  | { ok: false };

const GROUP_LABELS: Record<PaletteGroup, string> = {
  navigate: "Go To",
  action: "Actions",
  create: "Create",
};

const GROUP_ORDER: PaletteGroup[] = ["create", "action", "navigate"];
const LISTBOX_ID = "axis-command-palette-results";

const EXAMPLES = [
  "open gallery",
  "new note",
  "interface studio",
  "go to vitality",
  "schedule",
];

function safeErrorCode(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(value.error)
  ) {
    return value.error;
  }
  return "UNKNOWN";
}

function routineSuccessStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.runId === "string" &&
    record.runId.length > 0 &&
    typeof record.status === "string" &&
    record.status.length > 0
  ) {
    return record.status;
  }
  return null;
}

async function parseJsonResponse(response: Response): Promise<ParsedResponse> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

function routineFailureMessage(status: number, errorCode: string): string {
  if (status === 401) return "Your session expired. Sign in again before running this routine.";
  if (status === 403) return "You do not have permission to run this routine.";
  if (status === 409) return "The routine needs attention before it can continue.";
  if (status >= 500) return "The routine could not complete. Review its run before trying again.";
  if (errorCode !== "UNKNOWN") {
    return `The routine request was rejected (${errorCode.replaceAll("_", " ").toLowerCase()}).`;
  }
  return "The routine request was rejected. Review the request and try again.";
}

function firstAvailableIndex(items: readonly PaletteItem[]): number {
  const index = items.findIndex((item) => item.availability.available);
  return index < 0 ? 0 : index;
}

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const { openInterfaceStudio } = useTheme();
  const { toast } = useToast();
  const workspace = useWorkspace();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [exampleIdx, setExampleIdx] = useState(0);
  const [busyCommandId, setBusyCommandId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const routineInFlightRef = useRef(false);

  const specs = useMemo(() => buildPaletteCommandSpecs(), []);

  const resolveAvailability = useCallback(
    (spec: PaletteCommandSpec): CommandAvailability => {
      if (spec.availability.kind === "available") return { available: true };

      if (workspace.parseError) {
        return {
          available: false,
          reason: "Reset the invalid workspace URL state before using pane commands.",
        };
      }
      const requirementMissing = spec.availability.requires.some(
        (requirement) => {
          switch (requirement) {
            case "workspace-shell":
              return false;
            case "active-pane":
              return !workspace.activePane.id;
            case "multiple-panes":
              return !workspace.hasWorkspace;
          }
        },
      );
      if (requirementMissing) {
        return {
          available: false,
          reason: spec.availability.unavailableReason,
        };
      }
      if (
        spec.target.kind === "workspace-action" &&
        spec.target.action === "close-active-pane" &&
        !workspace.state.panes.some((pane) => pane.id === workspace.activePane.id)
      ) {
        return {
          available: false,
          reason: "Focus a secondary pane before closing it.",
        };
      }
      return { available: true };
    },
    [
      workspace.activePane.id,
      workspace.hasWorkspace,
      workspace.parseError,
      workspace.state.panes,
    ],
  );

  const filteredSpecs = useMemo(
    () => filterPaletteCommandSpecs(specs, query),
    [query, specs],
  );

  const groupedItems = useMemo(() => {
    const items = filteredSpecs.map<PaletteItem>((spec) => ({
      spec,
      availability: resolveAvailability(spec),
    }));
    if (query.trim()) return [{ group: null, items }];
    return GROUP_ORDER.map((group) => ({
      group,
      items: items.filter((item) => item.spec.group === group),
    })).filter(({ items: groupItems }) => groupItems.length > 0);
  }, [filteredSpecs, query, resolveAvailability]);

  const flatItems = useMemo(
    () => groupedItems.flatMap(({ items }) => items),
    [groupedItems],
  );

  const closePalette = useCallback(() => {
    if (busyCommandId) return;
    setInlineError(null);
    onClose();
  }, [busyCommandId, onClose]);

  const navigate = useCallback(
    (href: string) => {
      router.push(workspace.hrefWithWorkspace(href));
    },
    [router, workspace],
  );

  const reportRoutineFailure = useCallback(
    (
      failure: "network" | "server" | "invalid-response",
      routine: string,
      status?: number,
      errorCode?: string,
    ) => {
      Sentry.captureException(
        new Error(`Command palette routine ${failure} failure`),
        {
          tags: {
            area: "command_palette",
            operation: "run_routine",
            failure,
            routine,
            http_status: status ? String(status) : "unavailable",
            error_code: errorCode ?? "UNKNOWN",
          },
        },
      );
    },
    [],
  );

  const runRoutine = useCallback(
    async (spec: PaletteCommandSpec & {
      target: Extract<PaletteCommandSpec["target"], { kind: "run-routine" }>;
    }) => {
      setBusyCommandId(spec.id);
      setInlineError(null);

      try {
        const response = await fetch(`/api/routines/${spec.target.routine}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const parsed = await parseJsonResponse(response);

        if (!parsed.ok) {
          reportRoutineFailure(
            "invalid-response",
            spec.target.routine,
            response.status,
          );
          const message =
            "The routine returned an unreadable response. Check Tasks before trying again.";
          setInlineError(message);
          toast(message, "error", "Command Palette");
          return;
        }

        const errorCode = safeErrorCode(parsed.value);
        if (!response.ok) {
          if (response.status >= 500) {
            reportRoutineFailure(
              "server",
              spec.target.routine,
              response.status,
              errorCode,
            );
          }
          const message = routineFailureMessage(response.status, errorCode);
          setInlineError(message);
          toast(message, "error", "Command Palette");
          return;
        }

        const status = routineSuccessStatus(parsed.value);
        if (!status) {
          reportRoutineFailure(
            "invalid-response",
            spec.target.routine,
            response.status,
          );
          const message =
            "The routine response had no valid run record. Check Tasks before trying again.";
          setInlineError(message);
          toast(message, "error", "Command Palette");
          return;
        }

        const waitingForApproval = status === "waiting_for_approval";
        toast(
          waitingForApproval
            ? "Concentration check is waiting for approval."
            : "Concentration check completed.",
          waitingForApproval ? "info" : "success",
          "Command Palette",
        );
        onClose();
        setQuery("");
        navigate(spec.target.href);
      } catch {
        reportRoutineFailure("network", spec.target.routine);
        const message =
          "The routine response was lost. Check Tasks before retrying to avoid a duplicate run.";
        setInlineError(message);
        toast(message, "error", "Command Palette");
      } finally {
        routineInFlightRef.current = false;
        setBusyCommandId(null);
      }
    },
    [navigate, onClose, reportRoutineFailure, toast],
  );

  const runCommand = useCallback(
    async (item: PaletteItem) => {
      if (
        busyCommandId ||
        routineInFlightRef.current ||
        !item.availability.available
      ) {
        return;
      }

      const { spec } = item;
      const { target } = spec;

      if (target.kind === "run-routine") {
        routineInFlightRef.current = true;
        await runRoutine({
          ...spec,
          target,
        });
        return;
      }

      if (target.kind === "workspace-action") {
        const result = workspace.runWorkspaceAction(target.action);
        if (!result.ok) {
          const message =
            result.code === "PANE_LIMIT"
              ? "The workspace pane limit has been reached."
              : "The workspace URL could not be updated. Reset the workspace and try again.";
          setInlineError(message);
          toast(message, "error", "Command Palette");
          return;
        }
        setQuery("");
        setInlineError(null);
        onClose();
        return;
      }

      setQuery("");
      setInlineError(null);
      onClose();
      if (target.kind === "interface-studio") {
        openInterfaceStudio();
        return;
      }
      navigate(target.href);
    },
    [
      busyCommandId,
      navigate,
      onClose,
      openInterfaceStudio,
      runRoutine,
      toast,
      workspace,
    ],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (flatItems.length === 0 || busyCommandId) return;
      setActiveIdx((current) => {
        for (let offset = 1; offset <= flatItems.length; offset += 1) {
          const candidate =
            (current + direction * offset + flatItems.length) % flatItems.length;
          if (flatItems[candidate]?.availability.available) return candidate;
        }
        return current;
      });
    },
    [busyCommandId, flatItems],
  );

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(
      () => setExampleIdx((index) => (index + 1) % EXAMPLES.length),
      2200,
    );
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setQuery("");
      setInlineError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && wasOpenRef.current) {
      const previouslyFocused = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      requestAnimationFrame(() => previouslyFocused?.focus());
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(
    () => () => {
      previouslyFocusedRef.current?.focus();
    },
    [],
  );

  useEffect(() => {
    setActiveIdx(firstAvailableIndex(flatItems));
  }, [flatItems]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busyCommandId) {
          event.preventDefault();
          closePalette();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActive(-1);
        return;
      }
      if (event.key === "Enter" && flatItems[activeIdx]) {
        event.preventDefault();
        void runCommand(flatItems[activeIdx]);
        return;
      }
      if (event.key !== "Tab") return;

      const selector =
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[href],[tabindex]:not([tabindex="-1"])';
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(selector) ?? []),
      ].filter((node) => node.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      } else if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeIdx,
    busyCommandId,
    closePalette,
    flatItems,
    moveActive,
    open,
    runCommand,
  ]);

  if (!open) return null;

  const activeOptionId = flatItems[activeIdx]
    ? `axis-command-${flatItems[activeIdx].spec.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`
    : undefined;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 p-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        aria-busy={Boolean(busyCommandId)}
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: 560,
          background: "var(--surface)",
          border: "1px solid var(--line-strong)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow:
            "0 32px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.04) inset",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: "1px solid var(--line)",
            padding: "12px 16px",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
            style={{
              width: 15,
              height: 15,
              color: "var(--ink-faint)",
              flexShrink: 0,
            }}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Try "${EXAMPLES[exampleIdx]}"…`}
            role="combobox"
            aria-label="Find a command"
            aria-controls={LISTBOX_ID}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            aria-describedby={inlineError ? "axis-command-error" : undefined}
            disabled={Boolean(busyCommandId)}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 14,
              color: "var(--ink)",
              fontFamily: "var(--sans)",
            }}
          />
          {busyCommandId ? (
            <span
              role="status"
              style={{
                flexShrink: 0,
                color: "var(--gold)",
                fontFamily: "var(--mono)",
                fontSize: 9,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Running…
            </span>
          ) : (
            <>
              <span className="kbd" style={{ flexShrink: 0 }}>
                esc
              </span>
              <button
                type="button"
                onClick={closePalette}
                aria-label="Close command palette"
                style={{
                  display: "grid",
                  width: 24,
                  height: 24,
                  placeItems: "center",
                  border: "none",
                  borderRadius: 5,
                  background: "transparent",
                  color: "var(--ink-faint)",
                  cursor: "pointer",
                  fontSize: 16,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </>
          )}
        </div>

        {inlineError && (
          <div
            id="axis-command-error"
            role="alert"
            style={{
              borderBottom: "1px solid var(--line)",
              padding: "9px 16px",
              background:
                "color-mix(in srgb, var(--clay) 7%, var(--surface-2))",
              color: "var(--clay-2)",
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {inlineError}
          </div>
        )}

        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Available commands"
          style={{ maxHeight: "48vh", overflowY: "auto", padding: "8px 0" }}
        >
          {flatItems.length === 0 ? (
            <p
              role="status"
              style={{
                padding: "16px 20px",
                fontSize: 12,
                color: "var(--ink-faint)",
                fontFamily: "var(--mono)",
              }}
            >
              No matches for &ldquo;{query}&rdquo;
            </p>
          ) : (
            groupedItems.map(({ group, items }) => (
              <div key={group ?? "results"} role="presentation">
                {group && (
                  <div
                    role="presentation"
                    style={{
                      padding: "6px 16px 4px",
                      fontSize: 9,
                      fontFamily: "var(--mono)",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--ink-faint)",
                    }}
                  >
                    {GROUP_LABELS[group]}
                  </div>
                )}
                {items.map((item) => {
                  const globalIdx = flatItems.indexOf(item);
                  const isActive = globalIdx === activeIdx;
                  const isAvailable = item.availability.available;
                  const isBusy = busyCommandId === item.spec.id;
                  const optionId = `axis-command-${item.spec.id.replace(
                    /[^a-zA-Z0-9_-]/g,
                    "-",
                  )}`;

                  return (
                    <button
                      id={optionId}
                      key={item.spec.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={isActive}
                      aria-disabled={!isAvailable || Boolean(busyCommandId)}
                      disabled={!isAvailable || Boolean(busyCommandId)}
                      title={
                        isAvailable
                          ? item.spec.label
                          : item.availability.reason
                      }
                      onClick={() => void runCommand(item)}
                      onMouseEnter={() => {
                        if (isAvailable && !busyCommandId) {
                          setActiveIdx(globalIdx);
                        }
                      }}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 16px",
                        background: isActive
                          ? "var(--surface-2)"
                          : "transparent",
                        border: "none",
                        cursor: isAvailable ? "pointer" : "not-allowed",
                        textAlign: "left",
                        transition: "background 0.1s, opacity 0.1s",
                        opacity: isAvailable ? 1 : 0.58,
                      }}
                    >
                      {item.spec.icon && (
                        <Icon
                          icon={item.spec.icon}
                          size="xs"
                          className={
                            item.spec.group === "create"
                              ? "text-[var(--accent)]"
                              : item.spec.group === "action"
                                ? "text-[var(--gold,#c9a463)]"
                                : "text-[var(--ink-faint)]"
                          }
                        />
                      )}
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: 13.5,
                            color: isActive
                              ? "var(--ink)"
                              : "var(--ink-dim)",
                            fontFamily: "var(--sans)",
                          }}
                        >
                          {item.spec.label}
                        </span>
                        {!isAvailable && (
                          <span
                            style={{
                              display: "block",
                              marginTop: 2,
                              color: "var(--clay-2)",
                              fontFamily: "var(--mono)",
                              fontSize: 9,
                              lineHeight: 1.35,
                            }}
                          >
                            {item.availability.reason}
                          </span>
                        )}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: "var(--mono)",
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          color: isBusy ? "var(--gold)" : "var(--ink-faint)",
                          flexShrink: 0,
                        }}
                      >
                        {isBusy ? "Running…" : item.spec.hint}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            borderTop: "1px solid var(--line)",
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          {[
            { keys: ["↑", "↓"], label: "Navigate" },
            { keys: ["↵"], label: "Open" },
            { keys: ["esc"], label: "Close" },
          ].map(({ keys, label }) => (
            <div
              key={label}
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              {keys.map((key) => (
                <span key={key} className="kbd" style={{ fontSize: 9 }}>
                  {key}
                </span>
              ))}
              <span
                style={{
                  fontSize: 10,
                  color: "var(--ink-faint)",
                  fontFamily: "var(--mono)",
                }}
              >
                {label}
              </span>
            </div>
          ))}
          <span
            style={{
              marginLeft: "auto",
              fontSize: 10,
              color: "var(--ink-faint)",
              fontFamily: "var(--mono)",
              letterSpacing: "0.08em",
              display: "flex",
              gap: 10,
            }}
          >
            <span>⌘K nav</span>
            <span>⌘/ AI search</span>
          </span>
        </div>
      </div>
    </div>
  );
}
