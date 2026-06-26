"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type PersonTag = "mentor" | "collaborator" | "friend";

export type Person = {
  id: string;
  user_id: string;
  name: string;
  role: string;
  note: string;
  tag: PersonTag;
  last_contact_on: string | null;
  follow_up_on: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Normalize a person's name for fuzzy duplicate matching: trim, lowercase,
 * collapse internal whitespace, and strip common title prefixes (Dr./Mr./etc).
 * Used by the Dispatch "route to People" flow to detect an existing match
 * before creating a duplicate row.
 */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^(dr|mr|mrs|ms|miss|prof|professor)\.?\s+/i, "")
    .replace(/\s+/g, " ");
}

export function personIsDue(p: Person, now = new Date()) {
  if (!p.follow_up_on) return false;
  return new Date(`${p.follow_up_on}T23:59:59`) <= now || daysUntil(p.follow_up_on, now) <= 2;
}

function daysUntil(dateStr: string, now = new Date()) {
  const target = new Date(`${dateStr}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** Footer label matching the demo cards: "Follow up · 2d" or "Last: 4d" */
export function personFootLabel(p: Person, now = new Date()) {
  if (p.follow_up_on) {
    const d = daysUntil(p.follow_up_on, now);
    if (d < 0) return `Follow up · ${-d}d overdue`;
    if (d === 0) return "Follow up · today";
    return `Follow up · ${d}d`;
  }
  if (p.last_contact_on) {
    const d = -daysUntil(p.last_contact_on, now);
    if (d <= 0) return "Last: today";
    if (d < 14) return `Last: ${d}d`;
    return `Last: ${Math.round(d / 7)}w`;
  }
  return "No contact logged";
}

export function usePeople() {
  const supabase = useMemo(() => createClient(), []);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSignedIn(false);
      setPeople([]);
      setLoading(false);
      return;
    }
    setSignedIn(true);
    const { data } = await supabase
      .from("people")
      .select("*")
      .eq("user_id", user.id)
      .order("name", { ascending: true });
    setPeople((data ?? []) as Person[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addPerson = useCallback(async (partial: Partial<Person> & { name: string }) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to save people." };
    const { data, error } = await supabase
      .from("people")
      .insert({
        user_id: user.id,
        name: partial.name,
        role: partial.role ?? "",
        note: partial.note ?? "",
        tag: partial.tag ?? "collaborator",
        last_contact_on: partial.last_contact_on ?? null,
        follow_up_on: partial.follow_up_on ?? null,
      })
      .select()
      .single();
    if (error) return { error: error.message };
    setPeople((prev) => [...prev, data as Person].sort((a, b) => a.name.localeCompare(b.name)));
    return { data: data as Person };
  }, [supabase]);

  const updatePerson = useCallback(async (id: string, patch: Partial<Person>) => {
    const { data, error } = await supabase
      .from("people")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setPeople((prev) => prev.map((p) => (p.id === id ? (data as Person) : p)));
    return { data: data as Person };
  }, [supabase]);

  const deletePerson = useCallback(async (id: string) => {
    const { error } = await supabase.from("people").delete().eq("id", id);
    if (error) return { error: error.message };
    setPeople((prev) => prev.filter((p) => p.id !== id));
    return {};
  }, [supabase]);

  return { people, loading, signedIn, refresh, addPerson, updatePerson, deletePerson };
}

/** AI-backed triage: calls /api/ai for real extraction, heuristic fallback is server-side */
export async function triageSignalToPerson(signal: {
  title: string;
  body?: string | null;
}): Promise<{ name: string; role: string; note: string; tag: PersonTag }> {
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "triage-person", text: signal.title, body: signal.body }),
    });
    if (res.ok) {
      const data = (await res.json()) as { name: string; role: string; note: string; tag: PersonTag };
      return data;
    }
  } catch {
    // network error — fall through to heuristic
  }
  // local heuristic fallback
  const nameMatch = signal.title.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/);
  const name = (nameMatch?.[1] ?? signal.title).trim().slice(0, 80) || "Unknown";
  const lower = `${signal.title} ${signal.body ?? ""}`.toLowerCase();
  let tag: PersonTag = "collaborator";
  if (/mentor|advisor|professor|supervisor|pi\b/.test(lower)) tag = "mentor";
  if (/friend|birthday|catch up|personal/.test(lower)) tag = "friend";
  return { name, role: "", note: signal.body ?? "", tag };
}
