type CaptureMode = "task" | "note" | "paper";

type Props = {
  value: string;
  mode: CaptureMode | null;
  onValueChange: (value: string) => void;
  onModeChange: (mode: CaptureMode | null) => void;
  onCapture: () => void;
};

const CAPTURE_MODES = ["task", "note", "paper"] as const;

export function ConsoleCaptureBar({
  value,
  mode,
  onValueChange,
  onModeChange,
  onCapture,
}: Props) {
  return (
    <div className="capture" style={{ marginTop: "var(--section-gap)" }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <input
        placeholder="Capture a thought, task, paper, or expense…"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onCapture()}
      />
      {CAPTURE_MODES.map((captureMode) => (
        <button
          key={captureMode}
          type="button"
          className={`capt-pill${mode === captureMode ? " on" : ""}`}
          onClick={() => onModeChange(mode === captureMode ? null : captureMode)}
        >
          {captureMode.toUpperCase()}
        </button>
      ))}
      <button type="button" className="capt-go" onClick={onCapture}>Capture</button>
    </div>
  );
}
