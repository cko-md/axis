import { describe, expect, it } from "vitest";
import type { EntityRef } from "@/lib/entities/types";
import {
  MAX_ENCODED_WORKSPACE_STATE_LENGTH,
  MAX_PANE_HISTORY_ENTRIES,
  MAX_PANE_WIDTH_BPS,
  MAX_SECONDARY_PANES,
  MIN_PANE_WIDTH_BPS,
  PRIMARY_PANE_ID,
  clampPaneWidthBps,
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
  workspaceStateReducer,
  type WorkspaceState,
} from "@/lib/workspace";

const TEST_ENTITY_IDS = new Map<string, string>();

function ref(kind: EntityRef["kind"], label: string): EntityRef {
  if (kind === "holding") return { kind, id: label.toUpperCase() };
  const key = `${kind}:${label}`;
  let id = TEST_ENTITY_IDS.get(key);
  if (!id) {
    id = `00000000-0000-4000-8000-${String(TEST_ENTITY_IDS.size + 1).padStart(12, "0")}`;
    TEST_ENTITY_IDS.set(key, id);
  }
  return { kind, id };
}

function wireRef(kind: EntityRef["kind"], label: string): string {
  const entity = ref(kind, label);
  return `${entity.kind}:${entity.id}`;
}

function encodeWire(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function decodeWire(encoded: string): unknown {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function validWire(): Record<string, unknown> {
  return {
    version: 1,
    activePaneId: "pane-1",
    primary: {
      current: wireRef("note", "primary"),
      back: [],
      forward: [],
    },
    panes: [
      {
        id: "pane-1",
        widthBps: 3600,
        current: wireRef("task", "secondary"),
        back: [],
        forward: [],
      },
    ],
  };
}

function expectParseError(value: unknown, code: string): void {
  const parsed = parseWorkspaceState(encodeWire(value));
  expect(parsed).toEqual({ ok: false, error: { code } });
}

describe("workspace URL state codec", () => {
  it("round-trips deterministically through base64url UTF-8 JSON", () => {
    let state = createWorkspaceState(ref("note", "primary-roundtrip"));
    state = openWorkspacePane(state, ref("task", "secondary-roundtrip"));
    state = navigateWorkspacePane(state, "pane-1", ref("person", "next-roundtrip"));

    const first = serializeWorkspaceState(state);
    const second = serializeWorkspaceState(state);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.value.length).toBeLessThanOrEqual(
      MAX_ENCODED_WORKSPACE_STATE_LENGTH,
    );
    expect(parseWorkspaceState(first.value)).toEqual({ ok: true, value: state });
  });

  it("serializes only navigation structure and opaque entity references", () => {
    const state = openWorkspacePane(
      createWorkspaceState(ref("note", "opaque-primary-id")),
      ref("holding", "opaque-secondary-id"),
    );
    const serialized = serializeWorkspaceState(state);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const wire = decodeWire(serialized.value);
    expect(wire).toEqual({
      version: 1,
      activePaneId: "pane-1",
      primary: {
        current: wireRef("note", "opaque-primary-id"),
        back: [],
        forward: [],
      },
      panes: [
        {
          id: "pane-1",
          widthBps: 3600,
          current: "holding:OPAQUE-SECONDARY-ID",
          back: [],
          forward: [],
        },
      ],
    });
    const shape = JSON.stringify(wire);
    for (const privateField of ["title", "subtitle", "description", "content", "href"]) {
      expect(shape).not.toContain(privateField);
    }
  });

  it("returns safe structured errors for malformed, unknown, and oversized state", () => {
    expect(parseWorkspaceState(null)).toEqual({
      ok: false,
      error: { code: "EMPTY_STATE" },
    });
    expect(parseWorkspaceState("%secret-raw-state%")).toEqual({
      ok: false,
      error: { code: "INVALID_ENCODING" },
    });
    expect(parseWorkspaceState("a".repeat(MAX_ENCODED_WORKSPACE_STATE_LENGTH + 1))).toEqual({
      ok: false,
      error: { code: "STATE_TOO_LARGE" },
    });
    expect(parseWorkspaceState(encodeWire("not-an-object"))).toEqual({
      ok: false,
      error: { code: "INVALID_SHAPE" },
    });

    const invalidJson = btoa("{not-json").replace(/=+$/u, "");
    expect(parseWorkspaceState(invalidJson)).toEqual({
      ok: false,
      error: { code: "INVALID_JSON" },
    });

    const unknownVersion = validWire();
    unknownVersion.version = 2;
    expectParseError(unknownVersion, "UNSUPPORTED_VERSION");

    const unknownKind = validWire();
    (unknownKind.primary as Record<string, unknown>).current = "document:secret-id";
    const unknownKindResult = parseWorkspaceState(encodeWire(unknownKind));
    expect(unknownKindResult).toEqual({
      ok: false,
      error: { code: "UNKNOWN_ENTITY_KIND" },
    });
    expect(JSON.stringify(unknownKindResult)).not.toContain("secret-id");

    const malformedRef = validWire();
    (malformedRef.primary as Record<string, unknown>).current = "note:%E0%A4%A";
    expectParseError(malformedRef, "INVALID_ENTITY_REF");
  });

  it("rejects duplicate ids, duplicate refs, invalid widths, and invalid active panes", () => {
    const duplicateIds = validWire();
    duplicateIds.panes = [
      ...(duplicateIds.panes as unknown[]),
      {
        id: "pane-1",
        widthBps: 3600,
        current: wireRef("person", "another"),
        back: [],
        forward: [],
      },
    ];
    expectParseError(duplicateIds, "DUPLICATE_PANE_ID");

    const duplicateCurrent = validWire();
    (duplicateCurrent.panes as Array<Record<string, unknown>>)[0].current =
      wireRef("note", "primary");
    expectParseError(duplicateCurrent, "DUPLICATE_ENTITY_REF");

    const duplicateHistory = validWire();
    (duplicateHistory.primary as Record<string, unknown>).back = [
      wireRef("task", "old"),
      wireRef("task", "old"),
    ];
    expectParseError(duplicateHistory, "DUPLICATE_ENTITY_REF");

    const duplicateAcrossDirections = validWire();
    (duplicateAcrossDirections.primary as Record<string, unknown>).back = [
      wireRef("task", "old"),
    ];
    (duplicateAcrossDirections.primary as Record<string, unknown>).forward = [
      wireRef("task", "old"),
    ];
    expectParseError(duplicateAcrossDirections, "DUPLICATE_ENTITY_REF");

    const invalidWidth = validWire();
    (invalidWidth.panes as Array<Record<string, unknown>>)[0].widthBps = 17.5;
    expectParseError(invalidWidth, "INVALID_WIDTH");

    const invalidActive = validWire();
    invalidActive.activePaneId = "pane-missing";
    expectParseError(invalidActive, "INVALID_ACTIVE_PANE");

    const reservedPaneId = validWire();
    (reservedPaneId.panes as Array<Record<string, unknown>>)[0].id = PRIMARY_PANE_ID;
    expectParseError(reservedPaneId, "INVALID_PANE_ID");
  });

  it("rejects pane and history counts above their hard caps", () => {
    const tooManyPanes = validWire();
    tooManyPanes.panes = Array.from({ length: MAX_SECONDARY_PANES + 1 }, (_, index) => ({
      id: `pane-${index + 1}`,
      widthBps: 3600,
      current: wireRef("task", `pane-cap-${index + 1}`),
      back: [],
      forward: [],
    }));
    expectParseError(tooManyPanes, "TOO_MANY_PANES");

    const tooMuchHistory = validWire();
    (tooMuchHistory.primary as Record<string, unknown>).back = Array.from(
      { length: MAX_PANE_HISTORY_ENTRIES + 1 },
      (_, index) => wireRef("task", `history-cap-${index}`),
    );
    expectParseError(tooMuchHistory, "HISTORY_LIMIT_EXCEEDED");

    const extraField = validWire();
    extraField.privateTitle = "must not be accepted";
    expectParseError(extraField, "INVALID_SHAPE");
  });
});

describe("workspace pane state", () => {
  it("caps secondary panes and deduplicates currently open entities", () => {
    const initial = createWorkspaceState();
    const one = openWorkspacePane(initial, ref("note", "one"));
    const duplicate = openWorkspacePane(one, ref("note", "one"));
    expect(duplicate.panes).toHaveLength(1);
    expect(duplicate.activePaneId).toBe("pane-1");

    const two = openWorkspacePane(duplicate, ref("task", "two"));
    expect(two.panes).toHaveLength(MAX_SECONDARY_PANES);
    expect(two.activePaneId).toBe("pane-2");

    const capped = openWorkspacePane(two, ref("person", "three"));
    expect(capped).toBe(two);

    const focusExisting = openWorkspacePane(two, ref("note", "one"));
    expect(focusExisting.panes).toHaveLength(2);
    expect(focusExisting.activePaneId).toBe("pane-1");
  });

  it("caps and deduplicates history while clearing forward history on a branch", () => {
    let state = createWorkspaceState(ref("note", "zero"));
    for (let index = 1; index <= 20; index += 1) {
      state = navigateWorkspacePane(state, PRIMARY_PANE_ID, ref("note", String(index)));
    }
    expect(state.primary.back).toHaveLength(MAX_PANE_HISTORY_ENTRIES);
    expect(new Set(state.primary.back.map((entry) => entry.id)).size).toBe(
      state.primary.back.length,
    );

    state = navigateWorkspacePane(state, PRIMARY_PANE_ID, ref("note", "15"));
    expect(state.primary.current).toEqual(ref("note", "15"));
    expect(
      state.primary.back.filter((entry) => entry.id === ref("note", "15").id),
    ).toHaveLength(0);

    state = goBackInWorkspacePane(state, PRIMARY_PANE_ID);
    expect(state.primary.forward).toHaveLength(1);
    state = navigateWorkspacePane(state, PRIMARY_PANE_ID, ref("note", "branch"));
    expect(state.primary.forward).toEqual([]);
  });

  it("keeps navigation history independent for every pane", () => {
    let state = openWorkspacePane(
      createWorkspaceState(ref("note", "root")),
      ref("task", "task-a"),
    );
    state = openWorkspacePane(state, ref("person", "person-a"));
    state = navigateWorkspacePane(state, "pane-1", ref("task", "task-b"));
    state = navigateWorkspacePane(state, "pane-2", ref("person", "person-b"));

    const personBefore = state.panes[1];
    state = goBackInWorkspacePane(state, "pane-1");
    expect(state.panes[0].current).toEqual(ref("task", "task-a"));
    expect(state.panes[0].forward).toEqual([ref("task", "task-b")]);
    expect(state.panes[1]).toEqual(personBefore);

    state = goForwardInWorkspacePane(state, "pane-1");
    expect(state.panes[0].current).toEqual(ref("task", "task-b"));
    expect(state.panes[0].back).toEqual([ref("task", "task-a")]);
    expect(state.panes[1]).toEqual(personBefore);
  });

  it("focuses, closes, and clamps integer basis-point widths", () => {
    let state = openWorkspacePane(createWorkspaceState(), ref("note", "one"));
    state = openWorkspacePane(state, ref("task", "two"));
    state = resizeWorkspacePane(state, "pane-1", -500);
    state = resizeWorkspacePane(state, "pane-2", 99_999);
    expect(state.panes[0].widthBps).toBe(MIN_PANE_WIDTH_BPS);
    expect(state.panes[1].widthBps).toBe(MAX_PANE_WIDTH_BPS);
    expect(clampPaneWidthBps(Number.NaN)).toBe(3600);
    expect(clampPaneWidthBps(Number.POSITIVE_INFINITY)).toBe(MAX_PANE_WIDTH_BPS);
    expect(clampPaneWidthBps(Number.NEGATIVE_INFINITY)).toBe(MIN_PANE_WIDTH_BPS);

    state = focusWorkspacePane(state, "pane-1");
    expect(state.activePaneId).toBe("pane-1");
    state = closeWorkspacePane(state, "pane-1");
    expect(state.activePaneId).toBe("pane-2");
    state = closeWorkspacePane(state, "pane-2");
    expect(state.activePaneId).toBe(PRIMARY_PANE_ID);
  });

  it("supports the complete reducer action contract", () => {
    const initial = createWorkspaceState(ref("note", "root"));
    const opened = workspaceStateReducer(initial, {
      type: "open",
      ref: ref("task", "one"),
    });
    const navigated = workspaceStateReducer(opened, {
      type: "navigate",
      paneId: "pane-1",
      ref: ref("task", "two"),
    });
    const backed = workspaceStateReducer(navigated, {
      type: "back",
      paneId: "pane-1",
    });
    const forwarded = workspaceStateReducer(backed, {
      type: "forward",
      paneId: "pane-1",
    });
    const resized = workspaceStateReducer(forwarded, {
      type: "resize",
      paneId: "pane-1",
      widthBps: 4_125.4,
    });
    const focused = workspaceStateReducer(resized, {
      type: "focus",
      paneId: PRIMARY_PANE_ID,
    });
    const closed = workspaceStateReducer(focused, {
      type: "close",
      paneId: "pane-1",
    });

    expect(resized.panes[0].widthBps).toBe(4_125);
    expect(closed).toEqual({
      version: 1,
      activePaneId: PRIMARY_PANE_ID,
      primary: initial.primary,
      panes: [],
    } satisfies WorkspaceState);
  });

  it("trims oldest histories so reducer-produced mutations remain URL-safe", () => {
    const refs = (kind: EntityRef["kind"], prefix: string) =>
      Array.from({ length: MAX_PANE_HISTORY_ENTRIES }, (_, index) =>
        ref(kind, `${prefix}-${index}`),
      );
    const oversized: WorkspaceState = {
      version: 1,
      activePaneId: "pane-1",
      primary: {
        current: ref("note", "budget-primary"),
        back: refs("note", "budget-primary-back"),
        forward: refs("task", "budget-primary-forward"),
      },
      panes: [
        {
          id: "pane-1",
          widthBps: 3600,
          current: ref("person", "budget-pane-one"),
          back: refs("person", "budget-pane-one-back"),
          forward: refs("signal", "budget-pane-one-forward"),
        },
        {
          id: "pane-2",
          widthBps: 3600,
          current: ref("approval", "budget-pane-two"),
          back: refs("approval", "budget-pane-two-back"),
          forward: refs("routine_run", "budget-pane-two-forward"),
        },
      ],
    };
    expect(serializeWorkspaceState(oversized)).toEqual({
      ok: false,
      error: { code: "STATE_TOO_LARGE" },
    });

    const state = resizeWorkspacePane(oversized, "pane-1", 4_000);
    const encoded = serializeWorkspaceState(state);
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(encoded.value.length).toBeLessThanOrEqual(
        MAX_ENCODED_WORKSPACE_STATE_LENGTH,
      );
    }
    const retainedHistory =
      state.primary.back.length +
      state.primary.forward.length +
      state.panes.reduce(
        (total, pane) => total + pane.back.length + pane.forward.length,
        0,
      );
    expect(retainedHistory).toBeLessThan(MAX_PANE_HISTORY_ENTRIES * 6);
  });
});
