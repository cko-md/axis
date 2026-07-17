import {
  serializeEntityRef,
} from "@/lib/entities/registry";
import type { EntityRef } from "@/lib/entities/types";
import { serializeWorkspaceState } from "@/lib/workspace/codec";
import {
  DEFAULT_PANE_WIDTH_BPS,
  MAX_PANE_HISTORY_ENTRIES,
  MAX_PANE_WIDTH_BPS,
  MAX_TOTAL_SECONDARY_WIDTH_BPS,
  MAX_SECONDARY_PANES,
  MIN_PANE_WIDTH_BPS,
  PRIMARY_PANE_ID,
  WORKSPACE_STATE_VERSION,
  type WorkspaceAction,
  type WorkspacePaneHistory,
  type WorkspacePaneId,
  type WorkspaceSecondaryPane,
  type WorkspaceState,
} from "@/lib/workspace/types";

function refKey(ref: EntityRef): string {
  return serializeEntityRef(ref);
}

function sameRef(left: EntityRef | null, right: EntityRef | null): boolean {
  return Boolean(left && right && refKey(left) === refKey(right));
}

function uniqueHistory(
  refs: readonly EntityRef[],
  excluded: ReadonlySet<string> = new Set(),
): readonly EntityRef[] {
  const seen = new Set(excluded);
  const reversed: EntityRef[] = [];

  // Keep the most recent occurrence when callers supply duplicate history.
  for (let index = refs.length - 1; index >= 0; index -= 1) {
    const ref = refs[index];
    const key = refKey(ref);
    if (!seen.has(key)) {
      seen.add(key);
      reversed.push(ref);
    }
  }

  return reversed.reverse().slice(-MAX_PANE_HISTORY_ENTRIES);
}

function normalizeHistory(history: WorkspacePaneHistory): WorkspacePaneHistory {
  const currentKeys = history.current
    ? new Set([refKey(history.current)])
    : new Set<string>();
  const back = uniqueHistory(history.back, currentKeys);
  const backAndCurrent = new Set(currentKeys);
  for (const ref of back) backAndCurrent.add(refKey(ref));
  const forward = uniqueHistory(history.forward, backAndCurrent);
  return { current: history.current, back, forward };
}

function appendHistory(
  history: readonly EntityRef[],
  ref: EntityRef,
  excluded: ReadonlySet<string> = new Set(),
): readonly EntityRef[] {
  const key = refKey(ref);
  return uniqueHistory(
    [...history.filter((entry) => refKey(entry) !== key), ref],
    excluded,
  );
}

function replaceHistory(
  state: WorkspaceState,
  paneId: WorkspacePaneId,
  history: WorkspacePaneHistory,
): WorkspaceState {
  const normalized = normalizeHistory(history);
  if (paneId === PRIMARY_PANE_ID) {
    return { ...state, primary: normalized };
  }

  let found = false;
  const panes = state.panes.map((pane) => {
    if (pane.id !== paneId) return pane;
    found = true;
    if (!normalized.current) return pane;
    return { ...pane, ...normalized, current: normalized.current };
  });
  return found ? { ...state, panes } : state;
}

function historyForPane(
  state: WorkspaceState,
  paneId: WorkspacePaneId,
): WorkspacePaneHistory | null {
  if (paneId === PRIMARY_PANE_ID) return state.primary;
  return state.panes.find((pane) => pane.id === paneId) ?? null;
}

function nextPaneId(state: WorkspaceState): string {
  const ids = new Set(state.panes.map((pane) => pane.id));
  let sequence = 1;
  while (ids.has(`pane-${sequence}`)) sequence += 1;
  return `pane-${sequence}`;
}

function removeOldestFromLongestHistory(
  state: WorkspaceState,
): WorkspaceState | null {
  type Candidate = Readonly<{
    paneId: WorkspacePaneId;
    direction: "back" | "forward";
    length: number;
  }>;

  const candidates: Candidate[] = [
    {
      paneId: PRIMARY_PANE_ID,
      direction: "back",
      length: state.primary.back.length,
    },
    {
      paneId: PRIMARY_PANE_ID,
      direction: "forward",
      length: state.primary.forward.length,
    },
  ];
  for (const pane of state.panes) {
    candidates.push(
      { paneId: pane.id, direction: "back", length: pane.back.length },
      { paneId: pane.id, direction: "forward", length: pane.forward.length },
    );
  }

  candidates.sort((left, right) => right.length - left.length);
  const target = candidates[0];
  if (!target || target.length === 0) return null;
  const history = historyForPane(state, target.paneId);
  if (!history) return null;

  return replaceHistory(state, target.paneId, {
    ...history,
    [target.direction]: history[target.direction].slice(1),
  });
}

/**
 * Trims oldest history entries if long opaque identifiers would exceed the URL
 * budget. Current entities are never discarded; an unrepresentable mutation is
 * rejected by returning the previous state.
 */
function fitUrlBudget(
  candidate: WorkspaceState,
  previous: WorkspaceState,
): WorkspaceState {
  let compacted = candidate;
  while (true) {
    const encoded = serializeWorkspaceState(compacted);
    if (encoded.ok) return compacted;
    if (encoded.error.code !== "STATE_TOO_LARGE") return previous;
    const trimmed = removeOldestFromLongestHistory(compacted);
    if (!trimmed) return previous;
    compacted = trimmed;
  }
}

export function clampPaneWidthBps(
  widthBps: number,
  maxWidthBps = MAX_PANE_WIDTH_BPS,
): number {
  const boundedMax = Math.max(
    MIN_PANE_WIDTH_BPS,
    Math.min(MAX_PANE_WIDTH_BPS, Math.round(maxWidthBps)),
  );
  if (Number.isNaN(widthBps)) {
    return Math.min(DEFAULT_PANE_WIDTH_BPS, boundedMax);
  }
  return Math.min(
    boundedMax,
    Math.max(MIN_PANE_WIDTH_BPS, Math.round(widthBps)),
  );
}

export function createWorkspaceState(
  primary: EntityRef | null = null,
): WorkspaceState {
  return {
    version: WORKSPACE_STATE_VERSION,
    activePaneId: PRIMARY_PANE_ID,
    primary: { current: primary, back: [], forward: [] },
    panes: [],
  };
}

export function openWorkspacePane(
  state: WorkspaceState,
  ref: EntityRef,
): WorkspaceState {
  if (sameRef(state.primary.current, ref)) {
    return focusWorkspacePane(state, PRIMARY_PANE_ID);
  }
  const existing = state.panes.find((pane) => sameRef(pane.current, ref));
  if (existing) return focusWorkspacePane(state, existing.id);
  if (state.panes.length >= MAX_SECONDARY_PANES) return state;

  let existingPanes = state.panes;
  let newPaneWidth = DEFAULT_PANE_WIDTH_BPS;
  if (existingPanes.length === 1) {
    const existing = existingPanes[0];
    newPaneWidth = Math.max(
      MIN_PANE_WIDTH_BPS,
      Math.min(
        DEFAULT_PANE_WIDTH_BPS,
        MAX_TOTAL_SECONDARY_WIDTH_BPS - existing.widthBps,
      ),
    );
    const existingMax = MAX_TOTAL_SECONDARY_WIDTH_BPS - newPaneWidth;
    if (existing.widthBps > existingMax) {
      existingPanes = [{ ...existing, widthBps: existingMax }];
    }
  }

  const pane: WorkspaceSecondaryPane = {
    id: nextPaneId(state),
    widthBps: newPaneWidth,
    current: ref,
    back: [],
    forward: [],
  };
  const candidate: WorkspaceState = {
    ...state,
    activePaneId: pane.id,
    panes: [...existingPanes, pane],
  };
  return fitUrlBudget(candidate, state);
}

export function closeWorkspacePane(
  state: WorkspaceState,
  paneId: string,
): WorkspaceState {
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  if (index < 0) return state;
  const panes = state.panes.filter((pane) => pane.id !== paneId);
  const activePaneId =
    state.activePaneId === paneId
      ? (panes[Math.min(index, panes.length - 1)]?.id ?? PRIMARY_PANE_ID)
      : state.activePaneId;
  return { ...state, activePaneId, panes };
}

export function navigateWorkspacePane(
  state: WorkspaceState,
  paneId: WorkspacePaneId,
  ref: EntityRef,
): WorkspaceState {
  const history = historyForPane(state, paneId);
  if (!history) return state;
  if (sameRef(history.current, ref)) return focusWorkspacePane(state, paneId);

  // A current entity may appear in only one pane. Focus it rather than creating
  // two competing locations for the same entity.
  if (sameRef(state.primary.current, ref) && paneId !== PRIMARY_PANE_ID) {
    return focusWorkspacePane(state, PRIMARY_PANE_ID);
  }
  const existing = state.panes.find(
    (pane) => pane.id !== paneId && sameRef(pane.current, ref),
  );
  if (existing) return focusWorkspacePane(state, existing.id);

  const targetKey = refKey(ref);
  const backWithoutTarget = history.back.filter(
    (entry) => refKey(entry) !== targetKey,
  );
  const back = history.current
    ? appendHistory(backWithoutTarget, history.current, new Set([targetKey]))
    : backWithoutTarget;
  const candidate = replaceHistory(state, paneId, {
    current: ref,
    back,
    // Navigating from a historical location creates a new branch.
    forward: [],
  });
  if (candidate === state) return state;
  return fitUrlBudget({ ...candidate, activePaneId: paneId }, state);
}

export function goBackInWorkspacePane(
  state: WorkspaceState,
  paneId: WorkspacePaneId,
): WorkspaceState {
  const history = historyForPane(state, paneId);
  if (!history?.current || history.back.length === 0) return state;

  const current = history.back[history.back.length - 1];
  const back = history.back.slice(0, -1);
  const excluded = new Set(back.map(refKey));
  excluded.add(refKey(current));
  const forward = appendHistory(history.forward, history.current, excluded);
  const candidate = replaceHistory(state, paneId, { current, back, forward });
  return fitUrlBudget({ ...candidate, activePaneId: paneId }, state);
}

export function goForwardInWorkspacePane(
  state: WorkspaceState,
  paneId: WorkspacePaneId,
): WorkspaceState {
  const history = historyForPane(state, paneId);
  if (!history?.current || history.forward.length === 0) return state;

  const current = history.forward[history.forward.length - 1];
  const forward = history.forward.slice(0, -1);
  const excluded = new Set(forward.map(refKey));
  excluded.add(refKey(current));
  const back = appendHistory(history.back, history.current, excluded);
  const candidate = replaceHistory(state, paneId, { current, back, forward });
  return fitUrlBudget({ ...candidate, activePaneId: paneId }, state);
}

export function focusWorkspacePane(
  state: WorkspaceState,
  paneId: WorkspacePaneId,
): WorkspaceState {
  if (
    paneId !== PRIMARY_PANE_ID &&
    !state.panes.some((pane) => pane.id === paneId)
  ) {
    return state;
  }
  return state.activePaneId === paneId ? state : { ...state, activePaneId: paneId };
}

export function resizeWorkspacePane(
  state: WorkspaceState,
  paneId: string,
  widthBps: number,
): WorkspaceState {
  const otherPaneWidth = state.panes.reduce(
    (total, pane) => total + (pane.id === paneId ? 0 : pane.widthBps),
    0,
  );
  const availableWidth = MAX_TOTAL_SECONDARY_WIDTH_BPS - otherPaneWidth;
  const width = clampPaneWidthBps(widthBps, availableWidth);
  let found = false;
  let changed = false;
  const panes = state.panes.map((pane) => {
    if (pane.id !== paneId) return pane;
    found = true;
    if (pane.widthBps === width) return pane;
    changed = true;
    return { ...pane, widthBps: width };
  });
  if (!found || !changed) return state;
  return fitUrlBudget({ ...state, panes }, state);
}

export function workspaceStateReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "open":
      return openWorkspacePane(state, action.ref);
    case "close":
      return closeWorkspacePane(state, action.paneId);
    case "navigate":
      return navigateWorkspacePane(state, action.paneId, action.ref);
    case "back":
      return goBackInWorkspacePane(state, action.paneId);
    case "forward":
      return goForwardInWorkspacePane(state, action.paneId);
    case "focus":
      return focusWorkspacePane(state, action.paneId);
    case "resize":
      return resizeWorkspacePane(state, action.paneId, action.widthBps);
  }
}
