// NOTES-2: autosave status model. Pure + testable so the label the editor
// shows is derived from the *actual* write lifecycle, not a fixed timer that
// flips to "Saved" whether or not the Supabase write succeeded.

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

function relativeSavedAt(lastSavedAt: string, now: number): string {
  const savedAt = new Date(lastSavedAt).getTime();
  if (Number.isNaN(savedAt)) return "Saved";
  const ageSeconds = Math.max(0, Math.floor((now - savedAt) / 1000));
  if (ageSeconds < 5) return "Saved just now";
  if (ageSeconds < 60) return `Saved ${ageSeconds}s ago`;
  const savedTime = new Date(savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Saved ${savedTime}`;
}

// Label for the editor's autosave indicator. "saved"/"idle" both mean the
// buffer matches the server; the distinction is only whether a write just
// completed. When we have a confirmed timestamp, show it so "Saved" is a real
// claim, not a hopeful one.
export function formatAutosaveLabel(
  status: AutosaveStatus,
  lastSavedAt: string | null,
  now: number = Date.now(),
): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "error":
      return "Save failed";
    case "saved":
    case "idle":
      return lastSavedAt ? relativeSavedAt(lastSavedAt, now) : "Saved";
  }
}

export function autosaveStatusTone(status: AutosaveStatus): "pending" | "ok" | "error" {
  if (status === "saving") return "pending";
  if (status === "error") return "error";
  return "ok";
}
