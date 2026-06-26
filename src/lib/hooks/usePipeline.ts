"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Study = {
  id: string;
  user_id: string;
  stage_id: string;
  title: string;
  role: "First Author" | "Co-author";
  meta: string;
  next_action: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type PipelineStage = {
  id: string;
  user_id: string;
  name: string;
  swatch: string;
  sort_order: number;
  created_at: string;
};

export type ConferenceStatus = "accepted" | "abstract_due" | "invited" | "planned";

export type Conference = {
  id: string;
  user_id: string;
  name: string;
  location: string;
  date_label: string;
  status: ConferenceStatus;
  abstract: string;
  travel: string;
  next_step: string;
  linked_study_id: string | null;
  abstract_due_date: string | null;
  created_at: string;
  updated_at: string;
};

export const CONFERENCE_STATUS_LABELS: Record<ConferenceStatus, string> = {
  accepted: "Accepted",
  abstract_due: "Abstract Due",
  invited: "Invited",
  planned: "Planned",
};

// Default board scaffolding seeded on first sign-in (structure only — no demo studies)
const DEFAULT_STAGES = [
  { name: "Ideation", swatch: "var(--ink-faint)" },
  { name: "IRB / Regulatory", swatch: "var(--clay)" },
  { name: "Data / Analysis", swatch: "var(--accent)" },
  { name: "Drafting", swatch: "var(--up)" },
  { name: "Under Review", swatch: "var(--down)" },
];

export function usePipeline() {
  const supabase = useMemo(() => createClient(), []);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [conferences, setConferences] = useState<Conference[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSignedIn(false);
      setStages([]);
      setStudies([]);
      setConferences([]);
      setLoading(false);
      return;
    }
    setSignedIn(true);

    let { data: stageRows } = await supabase
      .from("pipeline_stages")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    if (!stageRows?.length) {
      const { data: seeded } = await supabase
        .from("pipeline_stages")
        .insert(DEFAULT_STAGES.map((s, i) => ({ ...s, user_id: user.id, sort_order: i })))
        .select();
      stageRows = (seeded ?? []).sort((a, b) => a.sort_order - b.sort_order);
    }

    const [studiesRes, confsRes] = await Promise.all([
      supabase.from("studies").select("*").eq("user_id", user.id).order("sort_order", { ascending: true }),
      supabase.from("conferences").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    ]);

    setStages((stageRows ?? []) as PipelineStage[]);
    setStudies((studiesRes.data ?? []) as Study[]);
    setConferences((confsRes.data ?? []) as Conference[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addStage = useCallback(async (name: string, swatch: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to customize stages." };
    const { data, error } = await supabase
      .from("pipeline_stages")
      .insert({ user_id: user.id, name, swatch, sort_order: stages.length })
      .select()
      .single();
    if (error) return { error: error.message };
    setStages((prev) => [...prev, data as PipelineStage]);
    return { data: data as PipelineStage };
  }, [supabase, stages.length]);

  const deleteStage = useCallback(async (id: string) => {
    const { error } = await supabase.from("pipeline_stages").delete().eq("id", id);
    if (error) return { error: error.message };
    setStages((prev) => prev.filter((s) => s.id !== id));
    setStudies((prev) => prev.filter((s) => s.stage_id !== id));
    return {};
  }, [supabase]);

  const addStudy = useCallback(async (partial: Partial<Study> & { stage_id: string; title: string }) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to save studies." };
    const { data, error } = await supabase
      .from("studies")
      .insert({
        user_id: user.id,
        stage_id: partial.stage_id,
        title: partial.title,
        role: partial.role ?? "First Author",
        meta: partial.meta ?? "",
        next_action: partial.next_action ?? "",
        sort_order: studies.filter((s) => s.stage_id === partial.stage_id).length,
      })
      .select()
      .single();
    if (error) return { error: error.message };
    setStudies((prev) => [...prev, data as Study]);
    return { data: data as Study };
  }, [supabase, studies]);

  const updateStudy = useCallback(async (id: string, patch: Partial<Study>) => {
    const { data, error } = await supabase
      .from("studies")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setStudies((prev) => prev.map((s) => (s.id === id ? (data as Study) : s)));
    return { data: data as Study };
  }, [supabase]);

  const deleteStudy = useCallback(async (id: string) => {
    const { error } = await supabase.from("studies").delete().eq("id", id);
    if (error) return { error: error.message };
    setStudies((prev) => prev.filter((s) => s.id !== id));
    return {};
  }, [supabase]);

  const addConference = useCallback(async (partial: Partial<Conference> & { name: string }) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Sign in to save conferences." };
    const { data, error } = await supabase
      .from("conferences")
      .insert({
        user_id: user.id,
        name: partial.name,
        location: partial.location ?? "",
        date_label: partial.date_label ?? "",
        status: partial.status ?? "planned",
        abstract: partial.abstract ?? "",
        travel: partial.travel ?? "",
        next_step: partial.next_step ?? "",
        linked_study_id: partial.linked_study_id ?? null,
        abstract_due_date: partial.abstract_due_date ?? null,
      })
      .select()
      .single();
    if (error) return { error: error.message };
    setConferences((prev) => [...prev, data as Conference]);
    return { data: data as Conference };
  }, [supabase]);

  const updateConference = useCallback(async (id: string, patch: Partial<Conference>) => {
    const { data, error } = await supabase
      .from("conferences")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setConferences((prev) => prev.map((c) => (c.id === id ? (data as Conference) : c)));
    return { data: data as Conference };
  }, [supabase]);

  const deleteConference = useCallback(async (id: string) => {
    const { error } = await supabase.from("conferences").delete().eq("id", id);
    if (error) return { error: error.message };
    setConferences((prev) => prev.filter((c) => c.id !== id));
    return {};
  }, [supabase]);

  return {
    stages,
    studies,
    conferences,
    loading,
    signedIn,
    refresh,
    addStage,
    deleteStage,
    addStudy,
    updateStudy,
    deleteStudy,
    addConference,
    updateConference,
    deleteConference,
  };
}
