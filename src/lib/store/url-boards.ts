export type UrlBoard = {
  id: string;
  name: string;
  createdAt: string;
  moduleIds: string[];
};

const BOARDS_KEY = "axis-url-boards";

export function loadUrlBoards(): UrlBoard[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(BOARDS_KEY) ?? "[]") as UrlBoard[];
  } catch {
    return [];
  }
}

export function saveUrlBoards(boards: UrlBoard[]) {
  try {
    localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
  } catch {
    /* ignore quota errors */
  }
}

function newBoardId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `b${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createUrlBoard(name: string): UrlBoard {
  return {
    id: newBoardId(),
    name: name.trim() || "Untitled board",
    createdAt: new Date().toISOString(),
    moduleIds: [],
  };
}

export function assignModuleToBoard(boards: UrlBoard[], boardId: string, moduleId: string): UrlBoard[] {
  return boards.map((b) => {
    if (b.id !== boardId) {
      return { ...b, moduleIds: b.moduleIds.filter((id) => id !== moduleId) };
    }
    if (b.moduleIds.includes(moduleId)) return b;
    return { ...b, moduleIds: [...b.moduleIds, moduleId] };
  });
}

export function removeModuleFromBoard(boards: UrlBoard[], boardId: string, moduleId: string): UrlBoard[] {
  return boards.map((b) =>
    b.id === boardId ? { ...b, moduleIds: b.moduleIds.filter((id) => id !== moduleId) } : b,
  );
}

export function isModuleOnBoard(board: UrlBoard, moduleId: string): boolean {
  return board.moduleIds.includes(moduleId);
}

export function reorderModulesOnBoard(
  boards: UrlBoard[],
  boardId: string,
  fromIndex: number,
  toIndex: number,
): UrlBoard[] {
  return boards.map((b) => {
    if (b.id !== boardId) return b;
    const next = [...b.moduleIds];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return b;
    next.splice(toIndex, 0, moved);
    return { ...b, moduleIds: next };
  });
}
