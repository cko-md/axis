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

export function createUrlBoard(name: string): UrlBoard {
  return {
    id: `b${Date.now().toString(36)}`,
    name: name.trim() || "Untitled board",
    createdAt: new Date().toISOString(),
    moduleIds: [],
  };
}
