"use client";

import * as Sentry from "@sentry/nextjs";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { PaletteWorkspaceAction } from "@/components/nav/command-palette-model";
import {
  normalizeEntityRef,
  parseEntityRef,
} from "@/lib/entities/registry";
import type { EntityRef } from "@/lib/entities/types";
import {
  DEFAULT_PANE_WIDTH_BPS,
  MAX_SECONDARY_PANES,
  PRIMARY_PANE_ID,
  closeWorkspacePane,
  createWorkspaceState,
  focusWorkspacePane,
  goBackInWorkspacePane,
  goForwardInWorkspacePane,
  navigateWorkspacePane,
  openWorkspacePane,
  parseWorkspaceState,
  resizeWorkspacePane,
  serializeWorkspaceState,
  type WorkspaceCodecErrorCode,
  type WorkspacePaneId,
  type WorkspaceState,
} from "@/lib/workspace";

export type WorkspaceOperationErrorCode = "PANE_LIMIT" | "ENCODE_FAILED";

export type WorkspaceOperationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: WorkspaceOperationErrorCode }>;

export type WorkspacePaneView = Readonly<{
  id: WorkspacePaneId;
  current: EntityRef | null;
  back: readonly EntityRef[];
  forward: readonly EntityRef[];
  widthBps: number | null;
}>;

export type WorkspaceContextValue = Readonly<{
  state: WorkspaceState;
  parseError: WorkspaceCodecErrorCode | null;
  hasWorkspace: boolean;
  activePane: WorkspacePaneView;
  currentPaneEntity: EntityRef | null;
  hrefWithWorkspace: (href: string) => string;
  openEntity: (ref: EntityRef) => WorkspaceOperationResult;
  navigatePane: (
    paneId: WorkspacePaneId,
    ref: EntityRef,
  ) => WorkspaceOperationResult;
  closePane: (paneId: string) => WorkspaceOperationResult;
  goBack: (paneId?: WorkspacePaneId) => WorkspaceOperationResult;
  goForward: (paneId?: WorkspacePaneId) => WorkspaceOperationResult;
  focusPane: (paneId: WorkspacePaneId) => WorkspaceOperationResult;
  resizePane: (paneId: string, widthBps: number) => WorkspaceOperationResult;
  resetWorkspace: () => WorkspaceOperationResult;
  runWorkspaceAction: (
    action: PaletteWorkspaceAction,
  ) => WorkspaceOperationResult;
}>;

type WorkspaceLocation = Readonly<{
  state: WorkspaceState;
  parseError: WorkspaceCodecErrorCode | null;
}>;

type WorkspaceHrefResult =
  | Readonly<{ ok: true; href: string }>
  | Readonly<{ ok: false; errorCode: WorkspaceCodecErrorCode }>;

const OK = { ok: true } as const satisfies WorkspaceOperationResult;
const ENCODE_FAILED = {
  ok: false,
  code: "ENCODE_FAILED",
} as const satisfies WorkspaceOperationResult;
const PANE_LIMIT = {
  ok: false,
  code: "PANE_LIMIT",
} as const satisfies WorkspaceOperationResult;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Resolves URL state into a safe state/error pair. The encoded value is never
 * retained in the returned error, so consumers cannot accidentally render it.
 */
export function resolveWorkspaceLocation(
  encoded: string | null | undefined,
): WorkspaceLocation {
  if (!encoded) {
    return { state: createWorkspaceState(), parseError: null };
  }

  const parsed = parseWorkspaceState(encoded);
  if (!parsed.ok) {
    return {
      state: createWorkspaceState(),
      parseError: parsed.error.code,
    };
  }
  return { state: parsed.value, parseError: null };
}

export function derivePrimaryEntity(
  pathname: string,
  currentSearch: string,
): EntityRef | null {
  const params = new URLSearchParams(currentSearch);
  if (pathname === "/tasks") {
    const ref = parseEntityRef(params.get("task"));
    return ref?.kind === "task" ? ref : null;
  }
  const holdingMatch = pathname.match(/^\/fund\/position\/([^/]+)$/u);
  if (holdingMatch) {
    try {
      return normalizeEntityRef({
        kind: "holding",
        id: decodeURIComponent(holdingMatch[1]),
      });
    } catch {
      return null;
    }
  }
  return null;
}

export function reconcilePrimaryEntity(
  state: WorkspaceState,
  primary: EntityRef | null,
): WorkspaceState {
  const normalized = primary ? normalizeEntityRef(primary) : null;
  const samePrimary =
    state.primary.current?.kind === normalized?.kind &&
    state.primary.current?.id === normalized?.id;
  const panes = normalized
    ? state.panes.filter(
        (pane) =>
          pane.current.kind !== normalized.kind ||
          pane.current.id !== normalized.id,
      )
    : state.panes;
  const activePaneId = panes.some((pane) => pane.id === state.activePaneId)
    ? state.activePaneId
    : PRIMARY_PANE_ID;
  if (
    samePrimary &&
    state.primary.back.length === 0 &&
    state.primary.forward.length === 0 &&
    panes.length === state.panes.length &&
    activePaneId === state.activePaneId
  ) {
    return state;
  }
  return {
    ...state,
    activePaneId,
    primary: { current: normalized, back: [], forward: [] },
    panes,
  };
}

/**
 * Builds the next workspace URL while preserving every unrelated query entry.
 * Workspace state is omitted entirely when the secondary topology is empty.
 */
export function buildWorkspaceHref(
  pathname: string,
  currentSearch: string,
  state: WorkspaceState,
): WorkspaceHrefResult {
  const params = new URLSearchParams(currentSearch);

  if (state.panes.length === 0) {
    params.delete("ws");
  } else {
    const serialized = serializeWorkspaceState(state);
    if (!serialized.ok) {
      return { ok: false, errorCode: serialized.error.code };
    }
    params.set("ws", serialized.value);
  }

  const query = params.toString();
  return { ok: true, href: query ? `${pathname}?${query}` : pathname };
}

/**
 * Carries a valid, non-empty workspace into another same-origin application
 * route. Invalid/external destinations are returned unchanged.
 */
export function appendWorkspaceToHref(
  href: string,
  encoded: string | null | undefined,
): string {
  if (!encoded || !href.startsWith("/") || href.startsWith("//")) return href;

  try {
    const target = new URL(href, "https://axis.local");
    target.searchParams.set("ws", encoded);
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return href;
  }
}

function currentPane(state: WorkspaceState): WorkspacePaneView {
  if (state.activePaneId !== PRIMARY_PANE_ID) {
    const pane = state.panes.find((candidate) => candidate.id === state.activePaneId);
    if (pane) {
      return {
        id: pane.id,
        current: pane.current,
        back: pane.back,
        forward: pane.forward,
        widthBps: pane.widthBps,
      };
    }
  }

  return {
    id: PRIMARY_PANE_ID,
    current: state.primary.current,
    back: state.primary.back,
    forward: state.primary.forward,
    widthBps: null,
  };
}

function containsCurrentEntity(state: WorkspaceState, ref: EntityRef): boolean {
  const normalized = normalizeEntityRef(ref);
  if (!normalized) return false;
  if (
    state.primary.current?.kind === normalized.kind &&
    state.primary.current.id === normalized.id
  ) {
    return true;
  }
  return state.panes.some(
    (pane) => pane.current.kind === normalized.kind && pane.current.id === normalized.id,
  );
}

function reportWorkspaceFailure(
  message: "Workspace URL state parse failed" | "Workspace URL state encode failed",
  errorCode: WorkspaceCodecErrorCode,
  encodedLength: number,
): void {
  Sentry.captureMessage(message, {
    level: message.endsWith("parse failed") ? "warning" : "error",
    tags: { error_code: errorCode },
    extra: { encoded_length: encodedLength },
  });
}

export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <WorkspaceResolvedProvider encoded={null} currentSearch="">
          {children}
        </WorkspaceResolvedProvider>
      }
    >
      <WorkspaceSearchParamsProvider>{children}</WorkspaceSearchParamsProvider>
    </Suspense>
  );
}

function WorkspaceSearchParamsProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const searchParams = useSearchParams();
  return (
    <WorkspaceResolvedProvider
      encoded={searchParams.get("ws")}
      currentSearch={searchParams.toString()}
    >
      {children}
    </WorkspaceResolvedProvider>
  );
}

function WorkspaceResolvedProvider({
  children,
  encoded,
  currentSearch,
}: {
  readonly children: ReactNode;
  readonly encoded: string | null;
  readonly currentSearch: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const location = useMemo(() => {
    const resolved = resolveWorkspaceLocation(encoded);
    const state = reconcilePrimaryEntity(
      resolved.state,
      derivePrimaryEntity(pathname, currentSearch),
    );
    return {
      ...resolved,
      state,
      requiresUrlNormalization: Boolean(encoded && state !== resolved.state),
    };
  }, [currentSearch, encoded, pathname]);
  const reportedParseFailure = useRef<string | null>(null);

  useEffect(() => {
    if (!location.parseError || !encoded) {
      reportedParseFailure.current = null;
      return;
    }
    const fingerprint = `${location.parseError}:${encoded.length}`;
    if (reportedParseFailure.current === fingerprint) return;
    reportedParseFailure.current = fingerprint;
    reportWorkspaceFailure(
      "Workspace URL state parse failed",
      location.parseError,
      encoded.length,
    );
  }, [encoded, location.parseError]);

  const writeState = useCallback(
    (
      nextState: WorkspaceState,
      historyMode: "push" | "replace",
    ): WorkspaceOperationResult => {
      const next = buildWorkspaceHref(pathname, currentSearch, nextState);
      if (!next.ok) {
        reportWorkspaceFailure(
          "Workspace URL state encode failed",
          next.errorCode,
          encoded?.length ?? 0,
        );
        return ENCODE_FAILED;
      }

      const currentHref = currentSearch ? `${pathname}?${currentSearch}` : pathname;
      if (next.href === currentHref) return OK;
      router[historyMode](next.href, { scroll: false });
      return OK;
    },
    [currentSearch, encoded?.length, pathname, router],
  );

  const openEntity = useCallback(
    (ref: EntityRef): WorkspaceOperationResult => {
      const normalized = normalizeEntityRef(ref);
      if (!normalized) {
        reportWorkspaceFailure(
          "Workspace URL state encode failed",
          "INVALID_ENTITY_REF",
          encoded?.length ?? 0,
        );
        return ENCODE_FAILED;
      }

      const alreadyOpen = containsCurrentEntity(location.state, normalized);
      if (!alreadyOpen && location.state.panes.length >= MAX_SECONDARY_PANES) {
        return PANE_LIMIT;
      }

      const nextState = openWorkspacePane(location.state, normalized);
      if (nextState === location.state && !alreadyOpen) {
        reportWorkspaceFailure(
          "Workspace URL state encode failed",
          "STATE_TOO_LARGE",
          encoded?.length ?? 0,
        );
        return ENCODE_FAILED;
      }

      return writeState(nextState, alreadyOpen ? "replace" : "push");
    },
    [encoded?.length, location.state, writeState],
  );

  useEffect(() => {
    if (!location.requiresUrlNormalization) return;
    writeState(location.state, "replace");
  }, [location.requiresUrlNormalization, location.state, writeState]);

  const navigatePane = useCallback(
    (paneId: WorkspacePaneId, ref: EntityRef): WorkspaceOperationResult => {
      const normalized = normalizeEntityRef(ref);
      if (!normalized) {
        reportWorkspaceFailure(
          "Workspace URL state encode failed",
          "INVALID_ENTITY_REF",
          encoded?.length ?? 0,
        );
        return ENCODE_FAILED;
      }
      return writeState(
        navigateWorkspacePane(location.state, paneId, normalized),
        "replace",
      );
    },
    [encoded?.length, location.state, writeState],
  );

  const closePane = useCallback(
    (paneId: string): WorkspaceOperationResult =>
      writeState(closeWorkspacePane(location.state, paneId), "push"),
    [location.state, writeState],
  );

  const goBack = useCallback(
    (paneId: WorkspacePaneId = location.state.activePaneId): WorkspaceOperationResult =>
      writeState(goBackInWorkspacePane(location.state, paneId), "replace"),
    [location.state, writeState],
  );

  const goForward = useCallback(
    (paneId: WorkspacePaneId = location.state.activePaneId): WorkspaceOperationResult =>
      writeState(goForwardInWorkspacePane(location.state, paneId), "replace"),
    [location.state, writeState],
  );

  const focusPane = useCallback(
    (paneId: WorkspacePaneId): WorkspaceOperationResult =>
      writeState(focusWorkspacePane(location.state, paneId), "replace"),
    [location.state, writeState],
  );

  const resizePane = useCallback(
    (paneId: string, widthBps: number): WorkspaceOperationResult =>
      writeState(
        resizeWorkspacePane(location.state, paneId, widthBps),
        "replace",
      ),
    [location.state, writeState],
  );

  const resetWorkspace = useCallback(
    (): WorkspaceOperationResult => writeState(createWorkspaceState(), "replace"),
    [writeState],
  );

  const hrefWithWorkspace = useCallback(
    (href: string): string =>
      location.parseError || location.state.panes.length === 0
        ? href
        : appendWorkspaceToHref(href, encoded),
    [encoded, location.parseError, location.state.panes.length],
  );

  const runWorkspaceAction = useCallback(
    (action: PaletteWorkspaceAction): WorkspaceOperationResult => {
      switch (action) {
        case "focus-next-pane": {
          const paneIds: WorkspacePaneId[] = [
            PRIMARY_PANE_ID,
            ...location.state.panes.map((pane) => pane.id),
          ];
          const currentIndex = paneIds.indexOf(location.state.activePaneId);
          const nextPaneId = paneIds[(currentIndex + 1) % paneIds.length];
          return writeState(
            focusWorkspacePane(location.state, nextPaneId),
            "replace",
          );
        }
        case "close-active-pane":
          if (location.state.activePaneId === PRIMARY_PANE_ID) return OK;
          return writeState(
            closeWorkspacePane(location.state, location.state.activePaneId),
            "push",
          );
        case "reset-pane-widths": {
          const nextState: WorkspaceState = {
            ...location.state,
            panes: location.state.panes.map((pane) =>
              pane.widthBps === DEFAULT_PANE_WIDTH_BPS
                ? pane
                : { ...pane, widthBps: DEFAULT_PANE_WIDTH_BPS },
            ),
          };
          return writeState(nextState, "replace");
        }
      }
    },
    [location.state, writeState],
  );

  const activePane = useMemo(() => currentPane(location.state), [location.state]);
  const value = useMemo<WorkspaceContextValue>(
    () => ({
      state: location.state,
      parseError: location.parseError,
      hasWorkspace: location.state.panes.length > 0,
      activePane,
      currentPaneEntity: activePane.current,
      hrefWithWorkspace,
      openEntity,
      navigatePane,
      closePane,
      goBack,
      goForward,
      focusPane,
      resizePane,
      resetWorkspace,
      runWorkspaceAction,
    }),
    [
      activePane,
      closePane,
      focusPane,
      goBack,
      goForward,
      hrefWithWorkspace,
      location.parseError,
      location.state,
      navigatePane,
      openEntity,
      resetWorkspace,
      resizePane,
      runWorkspaceAction,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return context;
}
