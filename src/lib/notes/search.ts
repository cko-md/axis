import type { Note } from "@/lib/hooks/useNotes";

// NOTES-3: pure, testable keyword filter for the in-Notes search box. Matches
// title + plain-text body, case-insensitive, so a note is findable by content
// as well as title without pulling in the whole HTML markup.

function stripHtmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function noteMatchesQuery(note: Pick<Note, "title" | "body">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (note.title.toLowerCase().includes(q)) return true;
  return stripHtmlToText(note.body).toLowerCase().includes(q);
}

export function filterNotesByKeyword<T extends Pick<Note, "title" | "body">>(notes: T[], query: string): T[] {
  const q = query.trim();
  if (!q) return notes;
  return notes.filter((n) => noteMatchesQuery(n, q));
}

// Orders notes to match a semantic-search result ranking (by note id), dropping
// notes that aren't in the result set. Keeps the module rendering real Note
// objects while honoring the semantic similarity order returned by the API.
export function orderNotesBySemanticIds<T extends Pick<Note, "id">>(notes: T[], orderedIds: string[]): T[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const out: T[] = [];
  for (const id of orderedIds) {
    const note = byId.get(id);
    if (note) out.push(note);
  }
  return out;
}
