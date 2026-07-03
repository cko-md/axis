"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";
import type { AutosaveStatus } from "@/lib/notes/save-status";

export type Note = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  folder: string;
  tags: string[];
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type NoteFont = "sans" | "serif" | "mono";
export const FONT_TAG_PREFIX = "__font:";
export const ARCHIVE_TAG = "__archived";
export const getNoteFont = (n: Note): NoteFont => {
  const tag = n.tags.find((t) => t.startsWith(FONT_TAG_PREFIX));
  return (tag?.slice(FONT_TAG_PREFIX.length) as NoteFont) ?? "sans";
};
export const fontTagsFor = (font: NoteFont, existing: string[]) => [
  ...existing.filter((t) => !t.startsWith(FONT_TAG_PREFIX)),
  ...(font === "sans" ? [] : [`${FONT_TAG_PREFIX}${font}`]),
];

const SEED = [
  { title: "Mechanism — DBS & Network Modulation", body: "Core hypothesis. Variability in clinical response to subthalamic DBS may be better explained by the patient-specific connectivity profile of the stimulated volume than by anatomical electrode position alone.", folder: "Research", tags: ["neuro", "thesis"] },
  { title: "Grant Aims — Restructure", body: "Aim 1 too broad. Split into mechanistic + outcomes arms.", folder: "Grants", tags: ["grant"] },
];

// Fire-and-forget: refreshes the note's embedding for semantic search. Silently
// no-ops if GEMINI_API_KEY isn't configured server-side — search degrades to
// quick (non-semantic) results rather than failing the note save.
function reembedNote(noteId: string, title: string, body: string) {
  const text = `${title}\n\n${body}`.trim();
  if (!text) return;
  fetch("/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noteId, text }),
  }).catch(() => {});
}

export function useNotes() {
  const supabase = useMemo(() => createClient(), []);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Autosave lifecycle for the currently-edited note (body/title debounced
  // writes). Drives a truthful "Saving…/Saved HH:MM/Save failed" indicator
  // and a Retry that re-sends the exact patch that failed.
  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const lastFailedSaveRef = useRef<{ id: string; patch: Partial<Note> } | null>(null);

  const recordError = useCallback((operation: string, rawError: unknown, message: string, noteId?: string) => {
    const err = rawError as { code?: string; status?: number } | null;
    setSaveError(message);
    Sentry.captureException(new Error(`Note ${operation} failed`), {
      tags: {
        area: "notes",
        operation,
        supabase_code: err?.code ?? "unknown",
      },
      contexts: {
        note: { id: noteId ?? null },
        supabase: { status: err?.status ?? null },
      },
    });
  }, []);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setNotes([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
    if (error) {
      recordError("load", error, "Could not load notes — check your connection and retry.");
      setLoading(false);
      return;
    }
    if (!data?.length) {
      const inserts = SEED.map((n, i) => ({ ...n, user_id: user.id, sort_order: i }));
      const { data: seeded, error: seedError } = await supabase.from("notes").insert(inserts).select();
      if (!seedError) {
        setNotes((seeded ?? []) as Note[]);
        setSaveError(null);
      } else {
        recordError("seed", seedError, "Could not initialize notes — check your connection and retry.");
      }
    } else {
      setNotes(data as Note[]);
      setSaveError(null);
    }
    setLoading(false);
  }, [recordError, supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "notes", userId, refresh);

  const createNote = useCallback(async (title: string, folder = "All Notes") => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from("notes")
        .insert({ user_id: user.id, title, body: "", folder, tags: [] })
        .select()
        .single();
      if (error || !data) {
        recordError("create", error, "Could not create note — check your connection and retry.");
        return null;
      }
      setNotes((prev) => [data as Note, ...prev]);
      setSaveError(null);
      return data as Note;
    } catch (err) {
      recordError("create", err, "Could not create note — check your connection and retry.");
      return null;
    }
  }, [recordError, supabase]);

  const updateNote = useCallback(async (id: string, patch: Partial<Note>) => {
    try {
      const { data, error } = await supabase.from("notes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
      if (error || !data) {
        recordError("update", error, "Could not save note — your latest edit is still on screen.");
        return;
      }
      setNotes((prev) => prev.map((n) => (n.id === id ? (data as Note) : n)));
      setSaveError(null);
      if (patch.title !== undefined || patch.body !== undefined) reembedNote(id, (data as Note).title, (data as Note).body);
    } catch (err) {
      recordError("update", err, "Could not save note — your latest edit is still on screen.", id);
    }
  }, [recordError, supabase]);

  // Shared write path for a debounced/retried autosave patch. Sets the save
  // lifecycle to "saving" → "saved" (with a confirmed timestamp) or "error"
  // (remembering the patch so Retry can re-send exactly what failed).
  const flushNoteSave = useCallback((id: string, patch: Partial<Note>) => {
    setSaveStatus("saving");
    supabase
      .from("notes")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          lastFailedSaveRef.current = { id, patch };
          setSaveStatus("error");
          recordError("autosave", error, "Autosave failed — your latest edit is still on screen.", id);
          return;
        }
        lastFailedSaveRef.current = null;
        setSaveError(null);
        setSaveStatus("saved");
        setLastSavedAt(new Date().toISOString());
        const savedNote = data as Note;
        setNotes((prev) => prev.map((n) => (n.id === id ? savedNote : n)));
        reembedNote(id, savedNote.title, savedNote.body);
      }, (err) => {
        lastFailedSaveRef.current = { id, patch };
        setSaveStatus("error");
        recordError("autosave", err, "Autosave failed — your latest edit is still on screen.", id);
      });
  }, [recordError, supabase]);

  // Debounced variant for keystroke-driven edits: local state updates immediately,
  // the Supabase write coalesces to one request per pause in typing.
  const updateNoteDebounced = useMemo(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pending = new Map<string, Partial<Note>>();
    return (id: string, patch: Partial<Note>) => {
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      pending.set(id, { ...pending.get(id), ...patch });
      setSaveStatus("saving");
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          const p = pending.get(id);
          pending.delete(id);
          if (p) flushNoteSave(id, p);
        }, 600),
      );
    };
  }, [flushNoteSave]);

  // Re-send the exact patch whose autosave last failed (no retyping needed).
  const retryFailedSave = useCallback(() => {
    const failed = lastFailedSaveRef.current;
    if (!failed) return;
    setSaveError(null);
    flushNoteSave(failed.id, failed.patch);
  }, [flushNoteSave]);

  const deleteNote = useCallback(async (id: string) => {
    try {
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (!error) {
        setNotes((prev) => prev.filter((n) => n.id !== id));
        setSaveError(null);
      } else {
        recordError("delete", error, "Could not delete note — check your connection and retry.", id);
      }
    } catch (err) {
      recordError("delete", err, "Could not delete note — check your connection and retry.", id);
    }
  }, [recordError, supabase]);

  // Lock state is stored as a sentinel tag so no schema migration is needed.
  const toggleLock = useCallback(async (id: string) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    const locked = note.tags.includes(LOCK_TAG);
    const tags = locked ? note.tags.filter((t) => t !== LOCK_TAG) : [...note.tags, LOCK_TAG];
    try {
      const { error } = await supabase.from("notes").update({ tags, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) {
        recordError("lock", error, "Could not update note lock — check your connection and retry.", id);
        return locked;
      }
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, tags } : n)));
      setSaveError(null);
      return !locked;
    } catch (err) {
      recordError("lock", err, "Could not update note lock — check your connection and retry.", id);
      return locked;
    }
  }, [notes, recordError, supabase]);

  const archiveNote = useCallback(async (id: string, archived = true) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    const tags = archived
      ? Array.from(new Set([...note.tags, ARCHIVE_TAG]))
      : note.tags.filter((t) => t !== ARCHIVE_TAG);
    const { data, error } = await supabase
      .from("notes")
      .update({ tags, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error || !data) {
      recordError("archive", error, "Could not archive note — check your connection and retry.", id);
      return false;
    }
    setNotes((prev) => prev.map((n) => (n.id === id ? (data as Note) : n)));
    setSaveError(null);
    return true;
  }, [notes, recordError, supabase]);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  return { notes, loading, saveError, saveStatus, lastSavedAt, retryFailedSave, clearSaveError, refresh, createNote, updateNote, updateNoteDebounced, deleteNote, toggleLock, archiveNote };
}

export const LOCK_TAG = "__locked";
export const isLocked = (n: Note) => n.tags.includes(LOCK_TAG);
export const isArchived = (n: Note) => n.tags.includes(ARCHIVE_TAG);
export const visibleTags = (n: Note) =>
  n.tags.filter((t) => t !== LOCK_TAG && t !== ARCHIVE_TAG && !t.startsWith(FONT_TAG_PREFIX));
