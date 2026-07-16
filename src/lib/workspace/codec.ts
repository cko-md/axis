import {
  isEntityKind,
  parseEntityRef,
  serializeEntityRef,
} from "@/lib/entities/registry";
import type { EntityRef } from "@/lib/entities/types";
import {
  MAX_ENCODED_WORKSPACE_STATE_LENGTH,
  MAX_PANE_HISTORY_ENTRIES,
  MAX_SECONDARY_PANES,
  MAX_WORKSPACE_PANE_ID_LENGTH,
  MAX_PANE_WIDTH_BPS,
  MIN_PANE_WIDTH_BPS,
  PRIMARY_PANE_ID,
  WORKSPACE_STATE_VERSION,
  type WorkspaceCodecErrorCode,
  type WorkspaceCodecResult,
  type WorkspacePaneHistory,
  type WorkspaceSecondaryPane,
  type WorkspaceState,
} from "@/lib/workspace/types";

type WireHistory = Readonly<{
  current: string | null;
  back: readonly string[];
  forward: readonly string[];
}>;

type WirePane = WireHistory &
  Readonly<{
    id: string;
    widthBps: number;
    current: string;
  }>;

type WireWorkspaceState = Readonly<{
  version: number;
  activePaneId: string;
  primary: WireHistory;
  panes: readonly WirePane[];
}>;

const PANE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function ok<T>(value: T): WorkspaceCodecResult<T> {
  return { ok: true, value };
}

function fail<T>(code: WorkspaceCodecErrorCode): WorkspaceCodecResult<T> {
  return { ok: false, error: { code } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isValidPaneId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== PRIMARY_PANE_ID &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_PANE_ID_LENGTH &&
    PANE_ID_PATTERN.test(value)
  );
}

function parseWireRef(value: unknown): WorkspaceCodecResult<EntityRef> {
  if (typeof value !== "string") return fail("INVALID_ENTITY_REF");

  const separator = value.indexOf(":");
  if (separator > 0 && !isEntityKind(value.slice(0, separator))) {
    return fail("UNKNOWN_ENTITY_KIND");
  }

  const ref = parseEntityRef(value);
  if (!ref) return fail("INVALID_ENTITY_REF");

  // Accept only the canonical representation so aliases cannot bypass duplicate
  // detection or produce multiple URLs for the same opaque reference.
  if (serializeEntityRef(ref) !== value) return fail("INVALID_ENTITY_REF");
  return ok(ref);
}

function parseWireRefs(
  value: unknown,
): WorkspaceCodecResult<readonly EntityRef[]> {
  if (!Array.isArray(value)) return fail("INVALID_SHAPE");
  if (value.length > MAX_PANE_HISTORY_ENTRIES) {
    return fail("HISTORY_LIMIT_EXCEEDED");
  }

  const refs: EntityRef[] = [];
  const seen = new Set<string>();
  for (const encodedRef of value) {
    const parsed = parseWireRef(encodedRef);
    if (!parsed.ok) return parsed;
    const key = serializeEntityRef(parsed.value);
    if (seen.has(key)) return fail("DUPLICATE_ENTITY_REF");
    seen.add(key);
    refs.push(parsed.value);
  }
  return ok(refs);
}

function parseWireHistory(
  value: unknown,
  currentRequired: boolean,
): WorkspaceCodecResult<WorkspacePaneHistory> {
  if (!isRecord(value)) return fail("INVALID_SHAPE");
  if (!hasExactKeys(value, ["current", "back", "forward"])) {
    return fail("INVALID_SHAPE");
  }

  let current: EntityRef | null = null;
  if (value.current !== null) {
    const parsedCurrent = parseWireRef(value.current);
    if (!parsedCurrent.ok) return parsedCurrent;
    current = parsedCurrent.value;
  } else if (currentRequired) {
    return fail("INVALID_ENTITY_REF");
  }

  const back = parseWireRefs(value.back);
  if (!back.ok) return back;
  const forward = parseWireRefs(value.forward);
  if (!forward.ok) return forward;

  const seen = new Set<string>();
  if (current) seen.add(serializeEntityRef(current));
  for (const ref of [...back.value, ...forward.value]) {
    const key = serializeEntityRef(ref);
    if (seen.has(key)) return fail("DUPLICATE_ENTITY_REF");
    seen.add(key);
  }

  return ok({ current, back: back.value, forward: forward.value });
}

function parseWirePane(
  value: unknown,
): WorkspaceCodecResult<WorkspaceSecondaryPane> {
  if (!isRecord(value)) return fail("INVALID_SHAPE");
  if (
    !hasExactKeys(value, ["id", "widthBps", "current", "back", "forward"])
  ) {
    return fail("INVALID_SHAPE");
  }
  if (!isValidPaneId(value.id)) return fail("INVALID_PANE_ID");
  if (
    typeof value.widthBps !== "number" ||
    !Number.isInteger(value.widthBps) ||
    value.widthBps < MIN_PANE_WIDTH_BPS ||
    value.widthBps > MAX_PANE_WIDTH_BPS
  ) {
    return fail("INVALID_WIDTH");
  }

  const history = parseWireHistory(
    { current: value.current, back: value.back, forward: value.forward },
    true,
  );
  if (!history.ok) return history;
  if (!history.value.current) return fail("INVALID_ENTITY_REF");

  return ok({
    id: value.id,
    widthBps: value.widthBps,
    current: history.value.current,
    back: history.value.back,
    forward: history.value.forward,
  });
}

function parseWireState(value: unknown): WorkspaceCodecResult<WorkspaceState> {
  if (!isRecord(value)) return fail("INVALID_SHAPE");
  if ("version" in value && value.version !== WORKSPACE_STATE_VERSION) {
    return fail("UNSUPPORTED_VERSION");
  }
  if (!hasExactKeys(value, ["version", "activePaneId", "primary", "panes"])) {
    return fail("INVALID_SHAPE");
  }
  if (value.version !== WORKSPACE_STATE_VERSION) {
    return fail("UNSUPPORTED_VERSION");
  }
  if (!Array.isArray(value.panes)) return fail("INVALID_SHAPE");
  if (value.panes.length > MAX_SECONDARY_PANES) {
    return fail("TOO_MANY_PANES");
  }

  const primary = parseWireHistory(value.primary, false);
  if (!primary.ok) return primary;

  const panes: WorkspaceSecondaryPane[] = [];
  const paneIds = new Set<string>();
  const currentRefs = new Set<string>();
  if (primary.value.current) {
    currentRefs.add(serializeEntityRef(primary.value.current));
  }

  for (const rawPane of value.panes) {
    const pane = parseWirePane(rawPane);
    if (!pane.ok) return pane;
    if (paneIds.has(pane.value.id)) return fail("DUPLICATE_PANE_ID");
    paneIds.add(pane.value.id);

    const currentKey = serializeEntityRef(pane.value.current);
    if (currentRefs.has(currentKey)) return fail("DUPLICATE_ENTITY_REF");
    currentRefs.add(currentKey);
    panes.push(pane.value);
  }

  if (
    typeof value.activePaneId !== "string" ||
    (value.activePaneId !== PRIMARY_PANE_ID && !paneIds.has(value.activePaneId))
  ) {
    return fail("INVALID_ACTIVE_PANE");
  }

  return ok({
    version: WORKSPACE_STATE_VERSION,
    activePaneId: value.activePaneId,
    primary: primary.value,
    panes,
  });
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): WorkspaceCodecResult<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    return fail("INVALID_ENCODING");
  }

  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("INVALID_ENCODING");
  }
}

function historyToWire(history: WorkspacePaneHistory): WireHistory {
  return {
    current: history.current ? serializeEntityRef(history.current) : null,
    back: history.back.map(serializeEntityRef),
    forward: history.forward.map(serializeEntityRef),
  };
}

function stateToWire(state: WorkspaceState): WireWorkspaceState {
  return {
    version: state.version,
    activePaneId: state.activePaneId,
    primary: historyToWire(state.primary),
    panes: state.panes.map((pane) => ({
      id: pane.id,
      widthBps: pane.widthBps,
      ...historyToWire(pane),
      current: serializeEntityRef(pane.current),
    })),
  };
}

/** Deterministically serializes safe, opaque workspace state for a URL. */
export function serializeWorkspaceState(
  state: WorkspaceState,
): WorkspaceCodecResult<string> {
  let wire: WireWorkspaceState;
  try {
    wire = stateToWire(state);
  } catch {
    return fail("INVALID_ENTITY_REF");
  }

  // Reuse the strict decoder validation for runtime callers that did not come
  // through the reducer (for example, state restored from another store).
  const validated = parseWireState(wire);
  if (!validated.ok) return validated;

  const encoded = encodeBase64Url(JSON.stringify(wire));
  if (encoded.length > MAX_ENCODED_WORKSPACE_STATE_LENGTH) {
    return fail("STATE_TOO_LARGE");
  }
  return ok(encoded);
}

/** Parses URL state without ever returning the raw input in an error. */
export function parseWorkspaceState(
  encoded: string | null | undefined,
): WorkspaceCodecResult<WorkspaceState> {
  if (!encoded) return fail("EMPTY_STATE");
  if (encoded.length > MAX_ENCODED_WORKSPACE_STATE_LENGTH) {
    return fail("STATE_TOO_LARGE");
  }

  const decoded = decodeBase64Url(encoded);
  if (!decoded.ok) return decoded;
  if (encodeBase64Url(decoded.value) !== encoded) {
    return fail("INVALID_ENCODING");
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded.value) as unknown;
  } catch {
    return fail("INVALID_JSON");
  }
  return parseWireState(value);
}
