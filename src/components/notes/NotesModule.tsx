"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTasks } from "@/lib/hooks/useTasks";
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
  isArchived,
  visibleTags,
  getNoteFont,
  fontTagsFor,
  type Note,
  type NoteFont,
} from "@/lib/hooks/useNotes";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import { Skeleton } from "@/components/ui/Skeleton";
import { NotesEditor } from "./NotesEditorLazy";
import { formatAutosaveLabel } from "@/lib/notes/save-status";
import { filterNotesByKeyword, orderNotesBySemanticIds } from "@/lib/notes/search";
import styles from "./NotesEditor.module.css";

const ARCHIVE_FOLDER = "Archive";
const DEFAULT_FOLDERS = ["All Notes", "Research", "Manuscripts", "Grants", "Clinical", "Personal", ARCHIVE_FOLDER];
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToNoteHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export function NotesModule() {
  const {
    notes,
    loading,
    saveError,
    saveStatus,
    lastSavedAt,
    retryFailedSave,
    clearSaveError,
    refresh: refreshNotes,
    createNote,
    updateNote,
    updateNoteDebounced,
    deleteNote,
    toggleLock,
    archiveNote,
  } = useNotes();
  const { addTask } = useTasks();
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
  const saving = saveStatus === "saving";

  // In-Notes search (NOTES-3). Keyword filtering is instant/client-side;
  // semantic search is an explicit action with its own lifecycle so its
  // loading/empty/error/unavailable states never block keyword search.
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState<
    | { status: "idle" }
    | { status: "loading"; query: string }
    | { status: "ready"; query: string; ids: string[] }
    | { status: "empty"; query: string }
    | { status: "error"; query: string; message: string }
    | { status: "unavailable"; query: string }
  >({ status: "idle" });
  const [newTag, setNewTag] = useState("");

  const [routing, setRouting] = useState(false);
  const [suggestion, setSuggestion] = useState<RouteSuggestion | null>(null);
  const [routingTo, setRoutingTo] = useState<null | "task" | "signal" | "pipeline">(null);

  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [aiPanel, setAiPanel] = useState<{ mode: string; content: string } | null>(null);

  // ── study aids (flashcards / quiz / mindmap / summary) ────────────────────
  type Flashcard = { front: string; back: string };
  type QuizItem = { question: string; answer: string };
  type MindMapNode = { label: string; children?: MindMapNode[] };
  type StudyAid =
    | { type: "flashcards"; cards: Flashcard[] }
    | { type: "quiz"; items: QuizItem[] }
    | { type: "mindmap"; root: MindMapNode }
    | { type: "summary"; summary: string };
  const [studyAidLoading, setStudyAidLoading] = useState<string | null>(null);
  const [studyAid, setStudyAid] = useState<StudyAid | null>(null);
  const supabase = useMemo(() => createClient(), []);

  // ── YouTube import ──────────────────────────────────────────────────────────
  const [ytOpen, setYtOpen] = useState(false);
  const [ytUrl, setYtUrl] = useState("");
  const [ytImporting, setYtImporting] = useState(false);

  // ── live transcription (Gemini) ─────────────────────────────────────────────
  const [liveTranscribing, setLiveTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const liveTranscriptionBodyRef = useRef("");

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
    const newBody = `${selected.body ?? ""}<p></p>${textToNoteHtml(`---\n${recSummary}`)}`;
    handleBodyChange(newBody);
    toast("Summary inserted into note", "success", "Notes");
    setRecState("idle");
  };

  const selected = useMemo(() => notes.find((n) => n.id === selectedId) ?? null, [notes, selectedId]);
  useEffect(() => {
    liveTranscriptionBodyRef.current = selected?.body ?? "";
  }, [selected?.body]);

  // keep ref in sync so stopRecording (which has no dep on selected) can read the title
  useEffect(() => { selectedTitleRef.current = selected?.title ?? ""; }, [selected]);
  const locked = selected ? isLocked(selected) : false;
  const noteFont: NoteFont = selected ? getNoteFont(selected) : "sans";

  const folderFiltered = useMemo(() => {
    if (activeFolder === ARCHIVE_FOLDER) return notes.filter(isArchived);
    const activeNotes = notes.filter((n) => !isArchived(n));
    if (activeFolder === "All Notes") return activeNotes;
    return activeNotes.filter((n) => n.folder === activeFolder);
  }, [notes, activeFolder]);

  // A search query supersedes the folder view: keyword search spans every
  // non-archived note (title + body text), and semantic search — when it has
  // resolved — reorders those to the API's similarity ranking.
  const trimmedQuery = query.trim();
  const filtered = useMemo(() => {
    if (!trimmedQuery) return folderFiltered;
    const searchable = notes.filter((n) => !isArchived(n));
    if (semantic.status === "ready" && semantic.query === trimmedQuery) {
      return orderNotesBySemanticIds(searchable, semantic.ids);
    }
    return filterNotesByKeyword(searchable, trimmedQuery);
  }, [trimmedQuery, folderFiltered, notes, semantic]);

  const folderCounts = useMemo(() => {
    const c: Record<string, number> = {};
    notes.forEach((n) => {
      if (isArchived(n)) {
        c[ARCHIVE_FOLDER] = (c[ARCHIVE_FOLDER] ?? 0) + 1;
        return;
      }
      c[n.folder] = (c[n.folder] ?? 0) + 1;
    });
    c["All Notes"] = notes.filter((n) => !isArchived(n)).length;
    return c;
  }, [notes]);

  useEffect(() => {
    if (!selectedId && filtered.length) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  const openNote = (n: Note) => {
    setSelectedId(n.id);
    setConfirmDelete(false);
    clearSaveError();
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
    clearSaveError();
    updateNoteDebounced(selected.id, { body: html });
  };

  const handleTitleChange = (title: string) => {
    if (!selected || locked) return;
    clearSaveError();
    updateNoteDebounced(selected.id, { title });
  };

  const clearSearch = () => {
    setQuery("");
    setSemantic({ status: "idle" });
  };

  const runSemanticSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSemantic({ status: "loading", query: q });
    try {
      const res = await fetch(`/api/search/semantic?q=${encodeURIComponent(q)}`);
      if (res.status === 503) {
        setSemantic({ status: "unavailable", query: q });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSemantic({ status: "error", query: q, message: body.error ?? "Semantic search failed." });
        return;
      }
      const data = (await res.json()) as { results?: Array<{ note_id: string }> };
      const ids = (data.results ?? []).map((r) => r.note_id);
      setSemantic(ids.length ? { status: "ready", query: q, ids } : { status: "empty", query: q });
    } catch {
      setSemantic({ status: "error", query: q, message: "Network error running semantic search." });
    }
  }, [query]);

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

  // Best-effort persistence — note_artifacts may not exist yet if the
  // migration hasn't landed; swallow errors so generation always still works.
  const persistStudyAid = async (aid: StudyAid) => {
    if (!selected) return;
    try {
      await supabase.from("note_artifacts").insert({
        note_id: selected.id,
        type: aid.type,
        data: aid,
      });
    } catch {
      /* table not migrated yet — non-fatal */
    }
  };

  const handleStudyAid = async (type: StudyAid["type"]) => {
    if (!selected || studyAidLoading) return;
    setStudyAidLoading(type);
    setStudyAid(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: type, text: selected.body, title: selected.title }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const aid: StudyAid =
        type === "flashcards" ? { type, cards: data.cards ?? [] } :
        type === "quiz" ? { type, items: data.items ?? [] } :
        type === "mindmap" ? { type, root: data.root ?? { label: selected.title || "Note" } } :
        { type, summary: data.summary ?? "" };
      setStudyAid(aid);
      void persistStudyAid(aid);
    } catch {
      toast(`Could not generate ${type} — check your API key`, "error", "Study Aids");
    } finally {
      setStudyAidLoading(null);
    }
  };

  const handleYoutubeImport = async () => {
    const url = ytUrl.trim();
    if (!url || ytImporting) return;
    setYtImporting(true);
    try {
      const res = await fetch("/api/notes/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Import failed");
      toast(`Imported "${data.title}"`, "success", "YouTube Import");
      setYtUrl("");
      setYtOpen(false);
      await refreshNotes();
      if (data?.note?.id) setSelectedId(data.note.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not import this video", "error", "YouTube Import");
    } finally {
      setYtImporting(false);
    }
  };

  // Records short audio chunks and transcribes each via Gemini, appending the
  // result into the active note as it arrives (near-real-time, chunk-based —
  // true Gemini Live bidirectional streaming isn't available from a Next.js
  // route handler; see src/app/api/notes/transcribe/route.ts).
  const toggleLiveTranscribe = async () => {
    if (liveTranscribing) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (!selected || locked) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      liveTranscriptionBodyRef.current = selected.body ?? "";
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (!e.data || e.data.size < 1000 || !selected) return;
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result as string;
              resolve(result.split(",")[1] ?? "");
            };
            reader.onerror = reject;
            reader.readAsDataURL(e.data);
          });
          const res = await fetch("/api/notes/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: base64, mimeType }),
          });
          const data = await res.json();
          const transcript = (data?.transcript ?? "").trim();
          if (transcript) {
            const appended = `${liveTranscriptionBodyRef.current}${textToNoteHtml(transcript)}`;
            liveTranscriptionBodyRef.current = appended;
            updateNoteDebounced(selected.id, { body: appended });
          }
        } catch {
          /* drop this chunk — recording continues */
        }
      };
      recorder.onstop = () => {
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setLiveTranscribing(false);
      };
      recorder.start(7000); // emit a chunk every 7s
      setLiveTranscribing(true);
    } catch {
      toast("Microphone access denied or unavailable", "error", "Live Transcribe");
    }
  };

  useEffect(() => () => {
    mediaRecorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // NOTES-4: explicit "send this note to another module" actions that create a
  // real, persisted artifact with source-back traceability (source_note_id +
  // source_route so Agenda/Dispatch can link back to the origin note). Distinct
  // from the AI folder-filing suggestion above, which only re-files the note.
  const noteSourceMetadata = (note: Note) => ({
    source_note_id: note.id,
    source_object_type: "note" as const,
    source_object_id: note.id,
    source_route: "/notes",
    created_via: "note_route" as const,
  });

  const routeNoteToTask = async (note: Note) => {
    setRoutingTo("task");
    try {
      const result = await addTask({
        title: note.title || "Untitled note",
        category: "personal",
        priority: "med",
        metadata: noteSourceMetadata(note),
      });
      toast(result ? "Task created in Agenda." : "Could not create task — sign in and try again.", result ? "success" : "error", "Notes");
    } finally {
      setRoutingTo(null);
    }
  };

  const routeNoteToSignal = async (note: Note) => {
    setRoutingTo("signal");
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast("Sign in to route notes to Dispatch.", "error", "Notes");
        return;
      }
      const { error } = await supabase.from("signals").insert({
        user_id: user.id,
        title: note.title || "Untitled note",
        body: preview(note.body).slice(0, 500) || null,
        signal_type: "action",
        source: "Notes",
        metadata: noteSourceMetadata(note),
      });
      if (error) {
        Sentry.captureException(error, { tags: { area: "notes", op: "route_to_signal", supabase_code: error.code ?? "unknown" } });
        toast("Could not send to Dispatch — check your connection and retry.", "error", "Notes");
        return;
      }
      toast("Sent to Dispatch.", "success", "Notes");
    } finally {
      setRoutingTo(null);
    }
  };

  const routeNoteToPipeline = async (note: Note) => {
    setRoutingTo("pipeline");
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast("Sign in to route notes to Pipeline.", "error", "Notes");
        return;
      }
      // Studies live on a board stage — target the user's first stage. If the
      // board hasn't been scaffolded yet, tell the user to open Pipeline once.
      const { data: stage, error: stageError } = await supabase
        .from("pipeline_stages")
        .select("id")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (stageError) {
        Sentry.captureException(stageError, { tags: { area: "notes", op: "route_to_pipeline_stage", supabase_code: stageError.code ?? "unknown" } });
        toast("Could not reach Pipeline — check your connection and retry.", "error", "Notes");
        return;
      }
      if (!stage) {
        toast("Open Pipeline once to set up your board, then route again.", "warn", "Notes");
        return;
      }
      const { error } = await supabase.from("studies").insert({
        user_id: user.id,
        stage_id: stage.id,
        title: note.title || "Untitled note",
        role: "First Author",
        meta: "From Notes",
        next_action: preview(note.body).slice(0, 200),
        sort_order: 0,
      });
      if (error) {
        Sentry.captureException(error, { tags: { area: "notes", op: "route_to_pipeline", supabase_code: error.code ?? "unknown" } });
        toast("Could not send to Pipeline — check your connection and retry.", "error", "Notes");
        return;
      }
      toast("Sent to Pipeline.", "success", "Notes");
    } finally {
      setRoutingTo(null);
    }
  };

  const acceptRoute = async () => {
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
      const result = await addTask({
        title: selected.title || "Untitled note task",
        category: "personal",
        priority: "med",
      });
      if (result) {
        toast(`Task created in Agenda: "${selected.title}"`, "success", "Routed");
      } else {
        toast("Could not create task — sign in and try again.", "error", "Routed");
      }
    }
    setSuggestion(null);
  };

  if (loading) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={40} borderRadius={6} style={{ opacity: 0.6 + i * 0.1 }} />)}
    </div>
  );

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
        saveLabel={locked ? undefined : formatAutosaveLabel(saveStatus, lastSavedAt)}
        editable={!locked}
        onRoute={handleRoute}
        routing={routing}
        font={noteFont}
        onFontChange={locked ? undefined : handleFontChange}
        window={{
          onPopout: () => {
            if (popout) {
              setPopout(false);
              setMinimized(false);
            } else {
              setPopout(true);
              setMinimized(false);
            }
          },
          onMinimize: () => setMinimized(true),
          isPopout: popout,
        }}
        ai={{
          onSummarize: !locked ? handleAiSummarize : undefined,
          onRewrite: !locked ? handleAiRewrite : undefined,
          onTitle: !locked ? handleAiTitle : undefined,
          loading: aiLoading,
        }}
      />

      {!locked && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--ink-faint)", letterSpacing: ".08em", textTransform: "uppercase" }}>
            Send to
          </span>
          <button type="button" className="savebtn" style={{ padding: "4px 10px", fontSize: 11 }} disabled={routingTo !== null} onClick={() => void routeNoteToTask(selected)}>
            {routingTo === "task" ? "Sending…" : "Agenda task"}
          </button>
          <button type="button" className="savebtn" style={{ padding: "4px 10px", fontSize: 11 }} disabled={routingTo !== null} onClick={() => void routeNoteToSignal(selected)}>
            {routingTo === "signal" ? "Sending…" : "Dispatch"}
          </button>
          <button type="button" className="savebtn" style={{ padding: "4px 10px", fontSize: 11 }} disabled={routingTo !== null} onClick={() => void routeNoteToPipeline(selected)}>
            {routingTo === "pipeline" ? "Sending…" : "Pipeline"}
          </button>
        </div>
      )}

      {saveError && (
        <div className="rec-panel" style={{ borderColor: "var(--down)", marginTop: 10 }}>
          <div className="rec-panel-head">
            <span>Save failed</span>
            <div style={{ display: "flex", gap: 6 }}>
              {saveStatus === "error" && (
                <button type="button" className="savebtn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={retryFailedSave}>
                  Retry
                </button>
              )}
              <button type="button" className="savebtn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={clearSaveError}>
                Dismiss
              </button>
            </div>
          </div>
          <div className="rec-panel-summary">{saveError}</div>
        </div>
      )}

      {/* Study aids + YouTube import + live transcription toolbar */}
      {!locked && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", letterSpacing: ".08em", textTransform: "uppercase", marginRight: 2 }}>
            Study Aids
          </span>
          {([
            ["flashcards", "Flashcards"],
            ["quiz", "Quiz"],
            ["mindmap", "Mind Map"],
            ["summary", "Summary"],
          ] as const).map(([type, label]) => (
            <button
              key={type}
              type="button"
              className="aibtn"
              disabled={!!studyAidLoading}
              onClick={() => handleStudyAid(type)}
            >
              {studyAidLoading === type ? "…" : label}
            </button>
          ))}
          <span style={{ width: 1, height: 16, background: "var(--line)", margin: "0 4px" }} />
          <button type="button" className="aibtn" onClick={() => setYtOpen((o) => !o)}>
            ▶ Import YouTube
          </button>
          <button
            type="button"
            className="aibtn"
            onClick={toggleLiveTranscribe}
            style={liveTranscribing ? { color: "var(--clay-2)", borderColor: "var(--clay-2)" } : undefined}
          >
            {liveTranscribing ? "● Stop transcribing" : "🎙 Live Transcribe"}
          </button>
        </div>
      )}

      {ytOpen && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input
            type="url"
            placeholder="Paste a YouTube link…"
            value={ytUrl}
            onChange={(e) => setYtUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleYoutubeImport(); }}
            className="ytimport-input"
            style={{
              flex: 1,
              background: "var(--surface-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              padding: "7px 10px",
              fontSize: 12,
              color: "var(--ink)",
              fontFamily: "var(--sans)",
            }}
          />
          <button type="button" className="aibtn" disabled={ytImporting || !ytUrl.trim()} onClick={handleYoutubeImport}>
            {ytImporting ? "Importing…" : "Import"}
          </button>
        </div>
      )}

      {/* Study aid result panel */}
      {studyAid && (
        <div className="rec-panel">
          <div className="rec-panel-head">
            <span>
              {studyAid.type === "flashcards" ? "Flashcards" :
                studyAid.type === "quiz" ? "Quiz" :
                studyAid.type === "mindmap" ? "Mind Map" : "Study Summary"}
            </span>
            <button type="button" className="savebtn" style={{ padding: "2px 8px", fontSize: 10 }} onClick={() => setStudyAid(null)}>
              Dismiss
            </button>
          </div>

          {studyAid.type === "flashcards" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, marginTop: 4 }}>
              {studyAid.cards.map((c, i) => (
                <details key={i} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "8px 10px" }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ink)" }}>{c.front}</summary>
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-dim)" }}>{c.back}</div>
                </details>
              ))}
            </div>
          )}

          {studyAid.type === "quiz" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              {studyAid.items.map((q, i) => (
                <details key={i} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "8px 10px" }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ink)" }}>{q.question}</summary>
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-dim)" }}>{q.answer}</div>
                </details>
              ))}
            </div>
          )}

          {studyAid.type === "mindmap" && (
            <div style={{ fontSize: 12, lineHeight: 1.7, marginTop: 4 }}>
              <div style={{ fontWeight: 600, color: "var(--gold)" }}>{studyAid.root.label}</div>
              <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                {(studyAid.root.children ?? []).map((child, i) => (
                  <li key={i} style={{ color: "var(--ink-dim)", marginBottom: 4 }}>
                    {child.label}
                    {child.children?.length ? (
                      <ul style={{ margin: "2px 0 0 16px" }}>
                        {child.children.map((grand, j) => (
                          <li key={j} style={{ color: "var(--ink-faint)", fontSize: 11.5 }}>{grand.label}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {studyAid.type === "summary" && (
            <div className="rec-panel-summary" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{studyAid.summary}</div>
          )}
        </div>
      )}

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
                  const html = textToNoteHtml(aiPanel.content);
                  handleBodyChange(html);
                  toast("Note rewritten", "success", "Notes AI");
                } else {
                  const appended = `${selected.body ?? ""}<p></p>${textToNoteHtml(aiPanel.content)}`;
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
      <button
        type="button"
        className="savebtn"
        style={{ marginTop: 12, marginLeft: 8 }}
        onClick={() => {
          if (locked) {
            toast("Unlock the note before archiving", "warn", "Notes");
            return;
          }
          const archived = isArchived(selected);
          archiveNote(selected.id, !archived).then((ok) => {
            if (!ok) return;
            toast(archived ? "Note restored" : "Note archived", "success", "Notes");
            if (!archived) setSelectedId(null);
          });
        }}
      >
        {isArchived(selected) ? "Restore note" : "Archive note"}
      </button>

      <div className="chips" style={{ marginTop: 12, alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        {visibleTags(selected).map((t) => (
          <span key={t} className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => updateNote(selected.id, { tags: selected.tags.filter((x) => x !== t) })}
              style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", padding: 0, lineHeight: 1, fontSize: 12 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const t = newTag.trim().toLowerCase();
              if (t && !selected.tags.includes(t)) {
                updateNote(selected.id, { tags: [...selected.tags, t] });
              }
              setNewTag("");
            }
          }}
          placeholder="+ add tag"
          style={{
            background: "none",
            border: "1px dashed var(--line-strong)",
            borderRadius: "var(--r)",
            color: "var(--ink)",
            font: "inherit",
            fontSize: 11,
            padding: "3px 8px",
            width: 88,
            outline: "none",
          }}
        />
      </div>
    </>
  ) : (
    <p style={{ color: "var(--ink-faint)" }}>Select or create a note to edit.</p>
  );

  return (
    <>
      <div className="divider" />

      <div className={`${styles.layout} ${styles.breakout}`}>
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
          <div className="capture" style={{ margin: "0 0 8px", padding: "9px 13px" }}>
            <input
              placeholder="New note…"
              style={{ padding: "3px 0", fontSize: 13 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleNew()}
            />
          </div>

          {/* Search (NOTES-3): keyword filter is instant; ⏎ / button runs semantic. */}
          <div style={{ margin: "0 0 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                placeholder="Search notes…"
                aria-label="Search notes"
                style={{
                  flex: 1, padding: "6px 10px", fontSize: 12.5, borderRadius: 6,
                  border: "1px solid var(--line)", background: "var(--surface-2)", color: "var(--ink)", outline: "none",
                }}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (semantic.status !== "idle") setSemantic({ status: "idle" });
                }}
                onKeyDown={(e) => { if (e.key === "Enter") void runSemanticSearch(); if (e.key === "Escape") clearSearch(); }}
              />
              {trimmedQuery && (
                <button
                  type="button"
                  className="savebtn"
                  style={{ padding: "5px 9px", fontSize: 11 }}
                  onClick={() => void runSemanticSearch()}
                  disabled={semantic.status === "loading"}
                  title="Semantic search (meaning, not just keywords)"
                >
                  {semantic.status === "loading" ? "…" : "✦ Semantic"}
                </button>
              )}
              {trimmedQuery && (
                <button type="button" className="savebtn" style={{ padding: "5px 9px", fontSize: 11 }} onClick={clearSearch} title="Clear search">
                  ×
                </button>
              )}
            </div>
            {semantic.status === "ready" && semantic.query === trimmedQuery && (
              <span style={{ fontSize: 10.5, color: "var(--marine-2)", fontFamily: "var(--mono)" }}>
                ✦ Semantic matches · {semantic.ids.length}
              </span>
            )}
            {semantic.status === "empty" && semantic.query === trimmedQuery && (
              <span style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>No semantic matches — showing keyword results.</span>
            )}
            {semantic.status === "unavailable" && (
              <span style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>Semantic search isn’t configured — keyword search still works.</span>
            )}
            {semantic.status === "error" && (
              <span style={{ fontSize: 10.5, color: "var(--clay)", display: "flex", gap: 8, alignItems: "center" }}>
                {semantic.message}
                <button type="button" className="savebtn" style={{ padding: "1px 7px", fontSize: 10 }} onClick={() => void runSemanticSearch()}>Retry</button>
              </span>
            )}
          </div>

          {filtered.length === 0 && (
            <p style={{ color: "var(--ink-faint)", fontSize: 12.5, padding: "4px 2px" }}>
              {trimmedQuery
                ? `No notes match “${trimmedQuery}”.`
                : `No notes in ${activeFolder}. Type above to create one.`}
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
        <div className={`card ${styles.editorCard}`}>
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
