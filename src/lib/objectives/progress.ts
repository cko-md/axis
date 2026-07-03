// OBJ-2: pure helpers for the key-result progress history — kept out of the
// hook/component so the delta math and label formatting are unit-testable.

export type KeyResultProgressEntry = {
  id: string;
  key_result_id: string;
  previous_value: number;
  new_value: number;
  delta: number;
  source: string;
  created_at: string;
};

// Human-readable source label for a logged change. `source` is a short machine
// tag ("manual", "ai_scan"); this turns it into the explanation shown in the
// history ("Manual +2", "AI scan −1") so a user can see where progress came from.
export function formatProgressEntry(entry: Pick<KeyResultProgressEntry, "delta" | "source">): string {
  const sign = entry.delta > 0 ? "+" : entry.delta < 0 ? "−" : "±";
  const magnitude = Math.abs(entry.delta);
  const label =
    entry.source === "manual" ? "Manual"
      : entry.source === "ai_scan" ? "AI scan"
        : entry.source === "reset" ? "Reset"
          : entry.source.charAt(0).toUpperCase() + entry.source.slice(1);
  return `${label} ${sign}${magnitude}`;
}

// Compact relative time for a history row ("just now", "3h ago", "Jul 2").
export function formatProgressTime(createdAt: string, now: number = Date.now()): string {
  const at = new Date(createdAt).getTime();
  if (Number.isNaN(at)) return "";
  const ageMinutes = Math.max(0, Math.floor((now - at) / 60000));
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Net change across a set of history entries (newest-first or any order) — used
// for the "▲ N this week" style summary on the objective detail.
export function netProgress(entries: Pick<KeyResultProgressEntry, "delta">[]): number {
  return entries.reduce((sum, e) => sum + e.delta, 0);
}
