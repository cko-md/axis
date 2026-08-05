export type CaptureResult = {
  label: string;
  action: string;
  priority: "hi" | "med" | "lo";
};

/**
 * Local, deterministic capture classification for callers that need a useful
 * label without routing a server request back through `/api/ai`.
 */
export function heuristicCapture(text: string): CaptureResult {
  const lower = text.toLowerCase();
  let priority: CaptureResult["priority"] = "med";
  if (/urgent|asap|critical|sign now/.test(lower)) priority = "hi";
  if (/fyi|low|whenever|someday/.test(lower)) priority = "lo";
  const label = priority === "hi" ? "Urgent" : priority === "lo" ? "Reference" : "Action";
  const action = `Add to ${priority === "lo" ? "reference" : "agenda"}`;
  return { label, action, priority };
}
