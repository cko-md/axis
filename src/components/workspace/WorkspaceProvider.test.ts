import { describe, expect, it } from "vitest";

import {
  appendWorkspaceToHref,
  buildWorkspaceHref,
  derivePrimaryEntity,
  reconcilePrimaryEntity,
  resolveWorkspaceLocation,
} from "@/components/workspace/WorkspaceProvider";
import type { EntityRef } from "@/lib/entities/types";
import {
  createWorkspaceState,
  openWorkspacePane,
  serializeWorkspaceState,
} from "@/lib/workspace";

const NOTE_REF: EntityRef = {
  kind: "note",
  id: "11111111-1111-4111-8111-111111111111",
};

describe("WorkspaceProvider URL helpers", () => {
  it("treats an absent workspace parameter as an empty, valid workspace", () => {
    const location = resolveWorkspaceLocation(null);

    expect(location.parseError).toBeNull();
    expect(location.state.panes).toEqual([]);
    expect(location.state.activePaneId).toBe("primary");
  });

  it("returns only a safe codec code for malformed URL state", () => {
    const location = resolveWorkspaceLocation("not-valid!");

    expect(location.parseError).toBe("INVALID_ENCODING");
    expect(location.state).toEqual(createWorkspaceState());
    expect(location).not.toHaveProperty("encoded");
  });

  it("preserves unrelated and repeated query parameters while replacing ws", () => {
    const state = openWorkspacePane(createWorkspaceState(), NOTE_REF);
    const result = buildWorkspaceHref(
      "/command",
      "view=week&ws=stale&filter=a&filter=b",
      state,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.href, "https://axis.test");
    expect(url.pathname).toBe("/command");
    expect(url.searchParams.get("view")).toBe("week");
    expect(url.searchParams.getAll("filter")).toEqual(["a", "b"]);

    const encoded = url.searchParams.get("ws");
    expect(encoded).not.toBe("stale");
    const restored = resolveWorkspaceLocation(encoded);
    expect(restored.parseError).toBeNull();
    expect(restored.state).toEqual(state);
  });

  it("deletes ws when no secondary pane remains", () => {
    const result = buildWorkspaceHref(
      "/notes",
      "ws=stale&note=keep-me&filter=one&filter=two",
      createWorkspaceState(NOTE_REF),
    );

    expect(result).toEqual({
      ok: true,
      href: "/notes?note=keep-me&filter=one&filter=two",
    });
  });

  it("round-trips a canonical encoded workspace location", () => {
    const state = openWorkspacePane(createWorkspaceState(), NOTE_REF);
    const encoded = serializeWorkspaceState(state);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    expect(resolveWorkspaceLocation(encoded.value)).toEqual({
      state,
      parseError: null,
    });
  });

  it("carries workspace state across safe internal routes only", () => {
    expect(appendWorkspaceToHref("/tasks?filter=active#detail", "encoded")).toBe(
      "/tasks?filter=active&ws=encoded#detail",
    );
    expect(appendWorkspaceToHref("https://example.test", "encoded")).toBe(
      "https://example.test",
    );
    expect(appendWorkspaceToHref("//example.test", "encoded")).toBe(
      "//example.test",
    );
  });

  it("derives supported full-page entities and removes duplicate evidence panes", () => {
    const task = {
      kind: "task",
      id: "22222222-2222-4222-8222-222222222222",
    } as const;
    const derived = derivePrimaryEntity(
      "/tasks",
      `task=${encodeURIComponent(`task:${task.id}`)}`,
    );
    expect(derived).toEqual(task);
    expect(derivePrimaryEntity("/notes", "note=note%3Ainvalid")).toBeNull();
    expect(derivePrimaryEntity("/fund/position/brk.b", "")).toEqual({
      kind: "holding",
      id: "BRK.B",
    });

    const state = openWorkspacePane(createWorkspaceState(NOTE_REF), task);
    expect(reconcilePrimaryEntity(state, task)).toEqual({
      ...state,
      activePaneId: "primary",
      primary: { current: task, back: [], forward: [] },
      panes: [],
    });
  });
});
