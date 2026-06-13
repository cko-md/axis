"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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

const SEED = [
  { title: "Mechanism — DBS & Network Modulation", body: "Core hypothesis. Variability in clinical response to subthalamic DBS may be better explained by the patient-specific connectivity profile of the stimulated volume than by anatomical electrode position alone.", folder: "Research", tags: ["neuro", "thesis"] },
  { title: "Grant Aims — Restructure", body: "Aim 1 too broad. Split into mechanistic + outcomes arms.", folder: "Grants", tags: ["grant"] },
];

export function useNotes() {
  const supabase = useMemo(() => createClient(), []);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setNotes([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase.from("notes").select("*").eq("user_id", user.id).order("updated_at", { ascending: false });
    if (!data?.length) {
      const inserts = SEED.map((n, i) => ({ ...n, user_id: user.id, sort_order: i }));
      const { data: seeded } = await supabase.from("notes").insert(inserts).select();
      setNotes((seeded ?? []) as Note[]);
    } else {
      setNotes(data as Note[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createNote = async (title: string, folder = "All Notes") => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase
      .from("notes")
      .insert({ user_id: user.id, title, body: "", folder, tags: [] })
      .select()
      .single();
    if (data) {
      setNotes((prev) => [data as Note, ...prev]);
      return data as Note;
    }
    return null;
  };

  const updateNote = async (id: string, patch: Partial<Note>) => {
    const { data } = await supabase.from("notes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (data) setNotes((prev) => prev.map((n) => (n.id === id ? (data as Note) : n)));
  };

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
              .then(undefined, () => {});
          }
        }, 600),
      );
    };
  }, [supabase]);

  const deleteNote = async (id: string) => {
    await supabase.from("notes").delete().eq("id", id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  // Lock state is stored as a sentinel tag so no schema migration is needed.
  const toggleLock = async (id: string) => {
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    const locked = note.tags.includes(LOCK_TAG);
    const tags = locked ? note.tags.filter((t) => t !== LOCK_TAG) : [...note.tags, LOCK_TAG];
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, tags } : n)));
    await supabase.from("notes").update({ tags, updated_at: new Date().toISOString() }).eq("id", id);
    return !locked;
  };

  return { notes, loading, refresh, createNote, updateNote, updateNoteDebounced, deleteNote, toggleLock };
}

export const LOCK_TAG = "__locked";
export const isLocked = (n: Note) => n.tags.includes(LOCK_TAG);
export const visibleTags = (n: Note) => n.tags.filter((t) => t !== LOCK_TAG);
