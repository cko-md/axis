import { describe, expect, it } from "vitest";
import { createUrlBoard, assignModuleToBoard, removeModuleFromBoard, reorderModulesOnBoard } from "./url-boards";

describe("createUrlBoard", () => {
  it("trims name and initializes empty module list", () => {
    const board = createUrlBoard("  Research  ");
    expect(board.name).toBe("Research");
    expect(board.moduleIds).toEqual([]);
    expect(board.id).toMatch(/^b/);
  });

  it("falls back to Untitled board for blank names", () => {
    expect(createUrlBoard("   ").name).toBe("Untitled board");
  });
});

describe("board module assignment", () => {
  it("assigns a module exclusively to one board", () => {
    const boards = [createUrlBoard("A"), createUrlBoard("B")];
    const moduleId = "m1";
    const next = assignModuleToBoard(boards, boards[0].id, moduleId);
    expect(next[0].moduleIds).toEqual([moduleId]);
    expect(next[1].moduleIds).toEqual([]);
    const moved = assignModuleToBoard(next, boards[1].id, moduleId);
    expect(moved[0].moduleIds).toEqual([]);
    expect(moved[1].moduleIds).toEqual([moduleId]);
  });

  it("removes module from board", () => {
    const board = createUrlBoard("A");
    board.moduleIds = ["m1"];
    const next = removeModuleFromBoard([board], board.id, "m1");
    expect(next[0].moduleIds).toEqual([]);
  });

  it("reorders modules within a board", () => {
    const board = createUrlBoard("A");
    board.moduleIds = ["m1", "m2", "m3"];
    const next = reorderModulesOnBoard([board], board.id, 0, 2);
    expect(next[0].moduleIds).toEqual(["m2", "m3", "m1"]);
  });
});
