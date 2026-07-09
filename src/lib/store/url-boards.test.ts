import { describe, expect, it } from "vitest";
import { createUrlBoard } from "./url-boards";

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
