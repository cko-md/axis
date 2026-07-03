export type PlatformTaskContext = {
  title?: unknown;
  priority?: unknown;
  category?: unknown;
  status?: unknown;
  deadline?: unknown;
};

export type PlatformNoteContext = {
  title?: unknown;
  body?: unknown;
};

export type PlatformSignalContext = {
  title?: unknown;
  signal_type?: unknown;
};

const MAX_TITLE_CHARS = 180;
const MAX_NOTE_BODY_CHARS = 200;
const MAX_CONTEXT_CHARS = 8_000;

function clean(value: unknown, maxChars: number): string {
  return typeof value === "string"
    ? value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars)
    : "";
}

export function buildObjectivesScanContext(input: {
  tasks?: PlatformTaskContext[] | null;
  notes?: PlatformNoteContext[] | null;
  signals?: PlatformSignalContext[] | null;
}): string {
  const taskLines = (input.tasks ?? [])
    .map((t) => {
      const title = clean(t.title, MAX_TITLE_CHARS);
      if (!title) return "";
      const priority = clean(t.priority, 20) || "med";
      const deadline = clean(t.deadline, 40);
      return `- ${title} [${priority}]${deadline ? ` due ${deadline}` : ""}`;
    })
    .filter(Boolean);

  const noteLines = (input.notes ?? [])
    .map((n) => {
      const title = clean(n.title, MAX_TITLE_CHARS);
      if (!title) return "";
      const body = clean(n.body, MAX_NOTE_BODY_CHARS);
      return `- ${title}${body ? `: ${body}` : ""}`;
    })
    .filter(Boolean);

  const signalLines = (input.signals ?? [])
    .map((s) => {
      const title = clean(s.title, MAX_TITLE_CHARS);
      if (!title) return "";
      return `- ${title} [${clean(s.signal_type, 20) || "fyi"}]`;
    })
    .filter(Boolean);

  return [
    taskLines.length ? `TASKS:\n${taskLines.join("\n")}` : "",
    noteLines.length ? `NOTES:\n${noteLines.join("\n")}` : "",
    signalLines.length ? `SIGNALS:\n${signalLines.join("\n")}` : "",
  ].filter(Boolean).join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

export function buildSignalsScanTaskContext(tasks: PlatformTaskContext[] | null | undefined): string {
  return (tasks ?? [])
    .map((t) => {
      const title = clean(t.title, MAX_TITLE_CHARS);
      if (!title) return "";
      const priority = clean(t.priority, 20) || "med";
      const category = clean(t.category, 40) || "general";
      const status = clean(t.status, 40) || "open";
      const deadline = clean(t.deadline, 40);
      return `[${priority.toUpperCase()}] ${title} (${category}, ${status}${deadline ? `, due ${deadline}` : ""})`;
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_CONTEXT_CHARS);
}
