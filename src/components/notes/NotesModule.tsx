"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useNotes,
  isLocked,
  visibleTags,
  getNoteFont,
  fontTagsFor,
  type Note,
  type NoteFont,
} from "@/lib/hooks/useNotes";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { NotesEditor } from "./NotesEditor";
import styles from "./NotesEditor.module.css";

const DEFAULT_FOLDERS = ["All Notes", "Research", "Manuscripts", "Grants", "Clinical", "Personal"];
const FOLDER_ORDER_KEY = "axis-notes-folder-order";
const CUSTOM_FOLDERS_KEY = "axis-notes-custom-folders";

function SortableFolder({
  folder,
  active,
  count,
  onPick,
  isDefault,
  onRename,
  onDelete,
}: {
  folder: string;
  active: string;
  count: number;
  onPick: (f: string) => void;
  isDefault: boolean;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (f: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder });
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(folder);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitRename = () => {
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== folder) onRename(folder, trimmed);
    setEditing(false);
  };

  return (
    <div
      ref={setNodeRef}
      suppressHydrationWarning
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, position: "relative" }}
      {...attributes}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {editing ? (
        <div className="coll" style={{ padding: "4px 8px" }}>
          <input
            ref={inputRef}
            autoFocus
            value={editVal}
            className="notes-folder-rename-input"
            onChange={(e) => setEditVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commitRename}
          />
        </div>
      ) : (
        <div
          className={folder === active ? "coll on" : "coll"}
          style={{ display: "flex", alignItems: "center", gap: 8 }}
          onClick={() => onPick(folder)}
          onDoubleClick={() => {
            if (!isDefault) {
              setEditVal(folder);
              setEditing(true);
            }
          }}
        >
          <span
            {...listeners}
            className="block-drag-handle"
            style={{ cursor: "grab", fontSize: 12, color: "var(--ink-faint)", flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            ⠿
          </span>
          {FOLDER_ICON}
          {folder}
          <span className="cc">{count}</span>
          {!isDefault && hover && (
            <button
              type="button"
              className="notes-folder-del"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(folder);
              }}
              title={`Delete ${folder}`}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const FOLDER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 7l2-3h6l2 3h6v13H3z" />
  </svg>
);

const LOCK_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const UNLOCK_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V8a4 4 0 0 1 7.5-2" />
  </svg>
);

const MIC_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="20" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const STOP_ICON = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);

type RouteSuggestion = {
  destination: "research" | "literature" | "task";
  label: string;
  reason: string;
  tags: string[];
};

function preview(html: string): string {
  if (!html) return "Empty note";
  const text = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Empty note";
}

export function NotesModule() {
  const { notes, loading, createNote, updateNote, updateNoteDebounced, deleteNote, toggleLock } = useNotes();
  const { toast } = useToast();

  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>(DEFAULT_FOLDERS);
  const [activeFolder, setActiveFolder] = useState("All Notes");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  const [popout, setPopout] = useState(false);
  const [minimized, setMinimized] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    try {
      const storedOrder = localStorage.getItem(FOLDER_ORDER_KEY);
      const storedCustom = localStorage.getItem(CUSTOM_FOLDERS_KEY);
      const custom: string[] = storedCustom ? (JSON.parse(storedCustom) as string[]) : [];
      setCustomFolders(custom);
      const allFolders = [...DEFAULT_FOLDERS, ...custom];
      if (storedOrder) {
        const parsed = JSON.parse(storedOrder) as string[];
        const hasAll = allFolders.every((f) => parsed.includes(f));
        if (hasAll && parsed.length === allFolders.length) {
          setFolders(parsed);
          return;
        }
      }
      setFolders(allFolders);
    } catch {
      /* ignore */
    }
  }, []);

  function persistFolders(next: string[], custom: string[]) {
    setFolders(next);
    setCustomFolders(custom);
    localStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(next));
    localStorage.setItem(CUSTOM_FOLDERS_KEY, JSON.stringify(custom));
  }

  function handleFolderDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = folders.indexOf(active.id as string);
    const to = folders.indexOf(over.id as string);
    const next = arrayMove(folders, from, to);
    const nextCustom = next.filter((f) => !DEFAULT_FOLDERS.includes(f));
    persistFolders(next, nextCustom);
  }

  function handleAddFolder() {
    const name = newFolderName.trim();
    if (!name || folders.includes(name)) return;
    const nextCustom = [...customFolders, name];
    persistFolders([...folders, name], nextCustom);
    setNewFolderName("");
    setAddingFolder(false);
  }

  function handleRenameFolder(oldName: string, newName: string) {
    if (!newName || folders.includes(newName)) return;
    const next = folders.map((f) => (f === oldName ? newName : f));
    const nextCustom = customFolders.map((f) => (f === oldName ? newName : f));
    persistFolders(next, nextCustom);
    if (activeFolder === oldName) setActiveFolder(newName);
  }

  function handleDeleteFolder(name: string) {
    if (DEFAULT_FOLDERS.includes(name)) return;
    const next = folders.filter((f) => f !== name);
    const nextCustom = customFolders.filter((f) => f !== name);
    persistFolders(next, nextCustom);
    if (activeFolder === name) setActiveFolder("All Notes");
  }

  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const [routing, setRouting] = useState(false);
  const [suggestion, setSuggestion] = useState<RouteSuggestion | null>(null);

  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [aiPanel, setAiPanel] = useState<{ mode: string; content: string } | null>(null);

  // ── meeting recorder ──────────────────────────────────────────
  type RecState = "idle" | "recording" | "processing" | "done" | "denied" | "unsupported";
  const [recState, setRecState] = useState<RecState>("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [recTranscript, setRecTranscript] = useState("");
  const [recSummary, setRecSummary] = useState("");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnySpeechRecognition = any;

  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recSpeechRef = useRef<AnySpeechRecognition>(null);
  const recTranscriptRef = useRef(""); // mutable accumulator

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const selectedTitleRef = useRef<string>("");

  const stopRecording = useCallback(async () => {
    // stop timer
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    recTimerRef.current = null;
    // stop speech recognition
    if (recSpeechRef.current) {
      recSpeechRef.current.stop();
      recSpeechRef.current = null;
    }
    const transcript = recTranscriptRef.current.trim();
    setRecTranscript(transcript);

    if (!transcript) {
      setRecState("idle");
      return;
    }

    setRecState("processing");
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "meeting-summary",
          text: transcript,
          title: selectedTitleRef.current,
        }),
      });
      const data = (await res.json()) as { summary: string };
      setRecSummary(data.summary ?? "");
      setRecState("done");
    } catch {
      setRecSummary("");
      setRecState("done");
    }
  }, []);

  const startRecording = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = typeof window !== "undefined" ? (window as any) : null;
    const SpeechRecognitionCtor = win
      ? (win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null)
      : null;

    if (!SpeechRecognitionCtor) {
      setRecState("unsupported");
      return;
    }

    recTranscriptRef.current = "";
    setRecTranscript("");
    setRecSummary("");
    setRecSeconds(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition: any = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => {
      let full = "";
      const results = e.results as unknown as ArrayLike<{ [j: number]: { transcript: string } }>;
      for (let i = 0; i < results.length; i++) {
        full += results[i][0].transcript + " ";
      }
      recTranscriptRef.current = full;
      setRecTranscript(full.trim());
    };

    recognition.onerror = (e: { error: string }) => {
      if (e.error === "not-allowed" || e.error === "permission-denied") {
        if (recTimerRef.current) clearInterval(recTimerRef.current);
        recTimerRef.current = null;
        setRecState("denied");
      } else {
        stopRecording();
      }
    };

    recognition.onend = () => {
      // safety net: if timer is still running when the recognition ends unexpectedly
      if (recTimerRef.current) {
        stopRecording();
      }
    };

    try {
      recognition.start();
      recSpeechRef.current = recognition;
      setRecState("recording");
      recTimerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch {
      setRecState("unsupported");
    }
  }, [stopRecording]);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      if (recSpeechRef.current) recSpeechRef.current.stop();
    };
  }, []);

  const insertSummaryIntoNote = () => {
    if (!selected || !recSummary) return;
    const mdBlock = `\n\n---\n${recSummary}\n`;
    // append as plain text into the note body (HTML)
    const newBody = (selected.body ?? "") + `<p></p><p>${mdBlock.replace(/\n/g, "<br/>")}</p>`;
    handleBodyChange(newBody);
    toast("Summary inserted into note", "success", "Notes");
    setRecState("idle");
  };

  const selected = useMemo(() => notes.find((n) => n.id === selectedId) ?? null, [notes, selectedId]);
  // keep ref in sync so stopRecording (which has no dep on selected) can read the title
  useEffect(() => { selectedTitleRef.current = selected?.title ?? ""; }, [selected]);
  const locked = selected ? isLocked(selected) : false;
  const noteFont: NoteFont = selected ? getNoteFont(selected) : "sans";

  const filtered = useMemo(() => {
    if (activeFolder === "All Notes") return notes;
    return notes.filter((n) => n.folder === activeFolder);
  }, [notes, activeFolder]);

  const folderCounts = useMemo(() => {
    const c: Record<string, number> = {};
    notes.forEach((n) => {
      c[n.folder] = (c[n.folder] ?? 0) + 1;
    });
    c["All Notes"] = notes.length;
    return c;
  }, [notes]);

  useEffect(() => {
    if (!selectedId && filtered.length) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  const openNote = (n: Note) => {
    setSelectedId(n.id);
    setConfirmDelete(false);
    setSuggestion(null);
  };

  const handleNew = async () => {
    if (!draft.trim()) return;
    const n = await createNote(draft.trim(), activeFolder === "All Notes" ? "Research" : activeFolder);
    if (n) {
      setDraft("");
      openNote(n);
    }
  };

  const handleBodyChange = (html: string) => {
    if (!selected || locked) return;
    setSaving(true);
    updateNoteDebounced(selected.id, { body: html });
    window.clearTimeout((handleBodyChange as unknown as { _t?: number })._t);
    (handleBodyChange as unknown as { _t?: number })._t = window.setTimeout(() => setSaving(false), 900);
  };

  const handleTitleChange = (title: string) => {
    if (!selected || locked) return;
    setSaving(true);
    updateNoteDebounced(selected.id, { title });
    window.clearTimeout((handleTitleChange as unknown as { _t?: number })._t);
    (handleTitleChange as unknown as { _t?: number })._t = window.setTimeout(() => setSaving(false), 900);
  };

  const handleFontChange = (font: NoteFont) => {
    if (!selected || locked) return;
    const tags = fontTagsFor(font, selected.tags);
    updateNote(selected.id, { tags });
  };

  const handleLock = async () => {
    if (!selected) return;
    const nowLocked = await toggleLock(selected.id);
    toast(nowLocked ? "Note locked — read-only" : "Note unlocked", nowLocked ? "info" : "success", "Notes");
  };

  const handleRoute = async () => {
    if (!selected) return;
    setRouting(true);
    setSuggestion(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "route", text: selected.title, body: selected.body }),
      });
      const data = (await res.json()) as RouteSuggestion;
      setSuggestion(data);
    } catch {
      toast("Could not reach the router", "error", "Notes");
    } finally {
      setRouting(false);
    }
  };

  const handleAiSummarize = async () => {
    if (!selected || aiLoading) return;
    setAiLoading("summarize");
    setAiPanel(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "notes-summarize", text: selected.body, title: selected.title }),
      });
      const { summary } = (await res.json()) as { summary: string };
      setAiPanel({ mode: "summarize", content: summary });
    } catch {
      toast("Could not summarize — check your API key", "error", "Notes AI");
    } finally {
      setAiLoading(null);
    }
  };

  const handleAiRewrite = async () => {
    if (!selected || aiLoading) return;
    setAiLoading("rewrite");
    setAiPanel(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "notes-rewrite", text: selected.body }),
      });
      const { rewritten } = (await res.json()) as { rewritten: string };
      setAiPanel({ mode: "rewrite", content: rewritten });
    } catch {
      toast("Could not rewrite — check your API key", "error", "Notes AI");
    } finally {
      setAiLoading(null);
    }
  };

  const handleAiTitle = async () => {
    if (!selected || aiLoading) return;
    setAiLoading("title");
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "notes-title", text: selected.body }),
      });
      const { title: suggested } = (await res.json()) as { title: string };
      if (suggested) {
        handleTitleChange(suggested);
        toast(`Title: "${suggested}"`, "success", "Notes AI");
      }
    } catch {
      toast("Could not generate title — check your API key", "error", "Notes AI");
    } finally {
      setAiLoading(null);
    }
  };

  const acceptRoute = () => {
    if (!selected || !suggestion) return;
    const folderMap: Record<RouteSuggestion["destination"], string> = {
      research: "Research",
      literature: "Manuscripts",
      task: selected.folder,
    };
    if (suggestion.destination !== "task") {
      updateNote(selected.id, { folder: folderMap[suggestion.destination] });
      toast(`Filed into ${folderMap[suggestion.destination]}`, "success", "Routed");
    } else {
      toast("Flagged as a task — add it in Agenda", "info", "Routed");
    }
    setSuggestion(null);
  };

  if (loading) return <div className="empty-state">Loading notes…</div>;

  const editorEl = selected ? (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <input
          value={selected.title}
          readOnly={locked}
          onChange={(e) => handleTitleChange(e.target.value)}
          style={{
            flex: 1,
            fontFamily: "var(--serif)",
            fontWeight: 400,
            fontSize: 26,
            marginBottom: 8,
            background: "none",
            border: "none",
            color: "var(--ink)",
            outline: "none",
          }}
        />
        {/* Record button */}
        {recState === "idle" || recState === "unsupported" || recState === "denied" ? (
          <button
            type="button"
            className="iconbtn"
            onClick={startRecording}
            title="Record meeting"
            style={{ marginTop: 4, flexShrink: 0 }}
          >
            {MIC_ICON}
          </button>
        ) : recState === "recording" ? (
          <button
            type="button"
            className="iconbtn"
            onClick={stopRecording}
            title="Stop recording"
            style={{ marginTop: 4, flexShrink: 0, borderColor: "var(--down)", color: "var(--down)" }}
          >
            {STOP_ICON}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.btn}
          onClick={handleLock}
          title={locked ? "Unlock note" : "Lock note (read-only)"}
          style={{ marginTop: 4, color: locked ? "var(--gold)" : "var(--ink-dim)" }}
        >
          {locked ? LOCK_ICON : UNLOCK_ICON}
        </button>
      </div>

      {/* Recording status bar */}
      {recState === "recording" && (
        <div className="rec-bar">
          <span className="rec-dot" />
          <span className="rec-timer">{formatTime(recSeconds)}</span>
          <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>Recording…</span>
          {recTranscript && (
            <span style={{ fontSize: 11, color: "var(--ink-faint)", fontStyle: "italic", marginLeft: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
              &ldquo;{recTranscript.slice(-60)}&rdquo;
            </span>
          )}
        </div>
      )}
      {recState === "processing" && (
        <div className="rec-bar">
          <span style={{ fontSize: 11, color: "var(--marine-2)" }}>Generating summary…</span>
        </div>
      )}
      {recState === "denied" && (
        <p className="rec-status-msg">Microphone access denied — please allow it in your browser settings and try again.</p>
      )}
      {recState === "unsupported" && (
        <p className="rec-status-msg">Speech recognition is not supported in this browser. Try Chrome or Edge.</p>
      )}

      <NotesEditor
        key={selected.id}
        content={selected.body}
        onChange={handleBodyChange}
        saving={saving}
        editable={!locked}
        onRoute={handleRoute}
        routing={routing}
        font={noteFont}
        onFontChange={locked ? undefined : handleFontChange}
        onPopout={() => {
          if (popout) {
            setPopout(false);
            setMinimized(false);
          } else {
            setPopout(true);
            setMinimized(false);
          }
        }}
        onMinimize={() => setMinimized(true)}
        isPopout={popout}
        onAiSummarize={!locked ? handleAiSummarize : undefined}
        onAiRewrite={!locked ? handleAiRewrite : undefined}
        onAiTitle={!locked ? handleAiTitle : undefined}
        aiLoading={aiLoading}
      />

      {/* Recording result panel */}
      {recState === "done" && (recTranscript || recSummary) && (
        <div className="rec-panel">
          <div className="rec-panel-head">
            <span>Meeting Recording</span>
            <button
              type="button"
              className="savebtn"
              style={{ padding: "2px 8px", fontSize: 10 }}
              onClick={() => { setRecState("idle"); setRecTranscript(""); setRecSummary(""); }}
            >
              Dismiss
            </button>
          </div>
          {recTranscript && (
            <>
              <div style={{ fontSize: 10, color: "var(--marine-2)", fontFamily: "var(--narrow)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 5 }}>Transcript</div>
              <div className="rec-panel-transcript">{recTranscript}</div>
            </>
          )}
          {recSummary && (
            <>
              <div style={{ fontSize: 10, color: "var(--gold)", fontFamily: "var(--narrow)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>AI Summary</div>
              <div className="rec-panel-summary">{recSummary}</div>
            </>
          )}
          {recSummary && (
            <div className="rec-panel-actions">
              <button
                type="button"
                className="aibtn"
                onClick={insertSummaryIntoNote}
                disabled={locked}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Insert into note
              </button>
              <button
                type="button"
                className="savebtn"
                onClick={() => {
                  setRecState("idle");
                  setRecTranscript("");
                  setRecSummary("");
                  startRecording();
                }}
              >
                Record again
              </button>
            </div>
          )}
        </div>
      )}

      {/* AI result panel */}
      {aiPanel && (
        <div className="rec-panel">
          <div className="rec-panel-head">
            <span>{aiPanel.mode === "summarize" ? "AI Summary" : "AI Rewrite"}</span>
            <button
              type="button"
              className="savebtn"
              style={{ padding: "2px 8px", fontSize: 10 }}
              onClick={() => setAiPanel(null)}
            >
              Dismiss
            </button>
          </div>
          <div style={{ fontSize: 10, color: "var(--gold)", fontFamily: "var(--narrow)", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>
            {aiPanel.mode === "summarize" ? "Summary" : "Rewritten draft"}
          </div>
          <div className="rec-panel-summary" style={{ whiteSpace: "pre-wrap" }}>{aiPanel.content}</div>
          <div className="rec-panel-actions">
            <button
              type="button"
              className="aibtn"
              disabled={locked}
              onClick={() => {
                if (!selected || locked) return;
                if (aiPanel.mode === "rewrite") {
                  const html = aiPanel.content
                    .split("\n\n")
                    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
                    .join("");
                  handleBodyChange(html);
                  toast("Note rewritten", "success", "Notes AI");
                } else {
                  const appended = (selected.body ?? "") + `<p></p><p>${aiPanel.content.replace(/\n/g, "<br/>")}</p>`;
                  handleBodyChange(appended);
                  toast("Summary inserted into note", "success", "Notes AI");
                }
                setAiPanel(null);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              {aiPanel.mode === "rewrite" ? "Replace note" : "Insert into note"}
            </button>
            <button type="button" className="savebtn" onClick={() => setAiPanel(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {suggestion && (
        <div className={styles.routeCard}>
          <div className={styles.routeEyebrow}>Suggested destination</div>
          <div className={styles.routeDest}>{suggestion.label}</div>
          <div className={styles.routeReason}>{suggestion.reason}</div>
          {suggestion.tags?.length > 0 && (
            <div className={styles.routeChips}>
              {suggestion.tags.map((t) => (
                <span key={t} className={styles.routeChip}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Button variant="primary" onClick={acceptRoute}>
              {suggestion.destination === "task" ? "Flag as task" : `Move to ${suggestion.label}`}
            </Button>
            <Button variant="ghost" onClick={() => setSuggestion(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <button
        type="button"
        className="savebtn"
        style={{ marginTop: 12, ...(confirmDelete ? { color: "var(--down)", borderColor: "var(--down)" } : {}) }}
        onClick={() => {
          if (locked) {
            toast("Unlock the note before deleting", "warn", "Notes");
            return;
          }
          if (!confirmDelete) {
            setConfirmDelete(true);
            return;
          }
          deleteNote(selected.id).then(() => {
            setSelectedId(null);
            setConfirmDelete(false);
            toast("Note deleted", "success", "Notes");
          });
        }}
        onBlur={() => setConfirmDelete(false)}
      >
        {confirmDelete ? "Click again to delete" : "Delete note"}
      </button>

      {visibleTags(selected).length > 0 && (
        <div className="chips" style={{ marginTop: 12 }}>
          {visibleTags(selected).map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
    </>
  ) : (
    <p style={{ color: "var(--ink-faint)" }}>Select or create a note to edit.</p>
  );

  return (
    <>
      <div className="divider" />

      <div style={{ display: "grid", gridTemplateColumns: "170px 250px 1fr", gap: 16, alignItems: "start" }}>
        {/* ── Folders (drag to reorder) ── */}
        <div>
          <div className="seclabel">Folders</div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd}>
            <SortableContext items={folders} strategy={verticalListSortingStrategy}>
              {folders.map((f) => (
                <SortableFolder
                  key={f}
                  folder={f}
                  active={activeFolder}
                  count={folderCounts[f] ?? 0}
                  onPick={setActiveFolder}
                  isDefault={DEFAULT_FOLDERS.includes(f)}
                  onRename={handleRenameFolder}
                  onDelete={handleDeleteFolder}
                />
              ))}
            </SortableContext>
          </DndContext>

          {addingFolder ? (
            <div className="coll" style={{ padding: "4px 8px", marginTop: 4 }}>
              <input
                ref={newFolderInputRef}
                autoFocus
                placeholder="Folder name…"
                value={newFolderName}
                className="notes-folder-rename-input"
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddFolder();
                  if (e.key === "Escape") {
                    setAddingFolder(false);
                    setNewFolderName("");
                  }
                }}
                onBlur={() => {
                  if (newFolderName.trim()) handleAddFolder();
                  else {
                    setAddingFolder(false);
                    setNewFolderName("");
                  }
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className="notes-folder-add"
              onClick={() => setAddingFolder(true)}
            >
              + New folder
            </button>
          )}
        </div>

        {/* ── Note list ── */}
        <div>
          <div className="capture" style={{ margin: "0 0 12px", padding: "9px 13px" }}>
            <input
              placeholder="New note…"
              style={{ padding: "3px 0", fontSize: 13 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleNew()}
            />
          </div>
          {filtered.length === 0 && (
            <p style={{ color: "var(--ink-faint)", fontSize: 12.5, padding: "4px 2px" }}>
              No notes in {activeFolder}. Type above to create one.
            </p>
          )}
          {filtered.map((n) => {
            const nLocked = isLocked(n);
            return (
              <div
                key={n.id}
                className="card"
                style={{
                  padding: 12,
                  borderLeft: selectedId === n.id ? "3px solid var(--accent)" : undefined,
                  marginBottom: 9,
                  cursor: "pointer",
                }}
                onClick={() => openNote(n)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
                  {nLocked && <span style={{ color: "var(--gold)", display: "inline-flex" }}>{LOCK_ICON}</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 5, lineHeight: 1.5 }}>
                  {preview(n.body).slice(0, 88)}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 7 }}>
                  {n.folder} · {new Date(n.updated_at).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Editor (embedded, shown when not popped out) ── */}
        <div className="card">
          {!popout ? (
            editorEl
          ) : (
            <p style={{ color: "var(--ink-faint)", fontSize: 13 }}>
              Note is open in a floating panel.{" "}
              <button
                type="button"
                className="savebtn"
                style={{ display: "inline", padding: "2px 8px", fontSize: 12 }}
                onClick={() => { setPopout(false); setMinimized(false); }}
              >
                Return
              </button>
            </p>
          )}
        </div>
      </div>

      {/* ── Pop-out overlay ── */}
      {popout && !minimized && (
        <div className="notes-popout">
          <div className="notes-popout-drag" />
          {editorEl}
        </div>
      )}

      {/* ── Minimized pill ── */}
      {popout && minimized && selected && (
        <div
          className="notes-pill"
          onClick={() => setMinimized(false)}
          title="Restore note"
        >
          <span className="notes-pill-dot" />
          <span className="notes-pill-title">
            {selected.title.slice(0, 24)}{selected.title.length > 24 ? "…" : ""}
          </span>
          <button
            type="button"
            className="notes-pill-close"
            onClick={(e) => { e.stopPropagation(); setPopout(false); setMinimized(false); }}
            title="Close"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
