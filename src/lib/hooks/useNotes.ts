"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

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

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setNotes([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
    if (error) { setLoading(false); return; }
    if (!data?.length) {
      const inserts = SEED.map((n, i) => ({ ...n, user_id: user.id, sort_order: i }));
      const { data: seeded, error: seedError } = await supabase.from("notes").insert(inserts).select();
      if (!seedError) setNotes((seeded ?? []) as Note[]);
    } else {
      setNotes(data as Note[]);
    }
    setLoading(false);
  }, [supabase]);

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
      if (error || !data) return null;
      setNotes((prev) => [data as Note, ...prev]);
      return data as Note;
    } catch (err) {
      console.error("[useNotes] createNote", err);
      return null;
    }
  }, [supabase]);

  const updateNote = useCallback(async (id: string, patch: Partial<Note>) => {
    try {
      const { data, error } = await supabase.from("notes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
      if (error || !data) return;
      setNotes((prev) => prev.map((n) => (n.id === id ? (data as Note) : n)));
      if (patch.title !== undefined || patch.body !== undefined) reembedNote(id, (data as Note).title, (data as Note).body);
    } catch (err) {
      console.error("[useNotes] updateNote", err);
    }
  }, [supabase]);

  // Debounced variant for keystroke-driven edits: local state updates immediately,
  // the Supabase write coalesces to one request per pause in typing.
  const updateNoteDebounced = useMemo(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pending = new Map<string, Partial<Note>>();
    return (id: string, patch: Partial<Note>) => {
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      pending.set(id, { ...pending.get(id), ...patch });
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          const p = pending.get(id);
          pending.delete(id);
          if (p) {
            supabase
              .from("notes")
              .update({ ...p, updated_at: new Date().toISOString() })
              .eq("id", id)
              .select("title, body")
              .single()
              .then(({ data }) => {
                if (data) reembedNote(id, data.title, data.body);
              }, () => {});
          }
        }, 600),
      );
    };
  }, [supabase]);

  const deleteNote = useCallback(async (id: string) => {
    try {
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (!error) setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      console.error("[useNotes] deleteNote", err);
    }
  }, [supabase]);

  // Lock state is stored as a sentinel tag so no schema migration is needed.
  const toggleLock = useCallback(async (id: string) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    const locked = note.tags.includes(LOCK_TAG);
    const tags = locked ? note.tags.filter((t) => t !== LOCK_TAG) : [...note.tags, LOCK_TAG];
    try {
      const { error } = await supabase.from("notes").update({ tags, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return locked;
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, tags } : n)));
      return !locked;
    } catch (err) {
      console.error("[useNotes] toggleLock", err);
      return locked;
    }
  }, [notes, supabase]);

  return { notes, loading, refresh, createNote, updateNote, updateNoteDebounced, deleteNote, toggleLock };
}

export const LOCK_TAG = "__locked";
export const isLocked = (n: Note) => n.tags.includes(LOCK_TAG);
export const visibleTags = (n: Note) =>
  n.tags.filter((t) => t !== LOCK_TAG && !t.startsWith(FONT_TAG_PREFIX));
