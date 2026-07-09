"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setSignedIn(false);
      setStages([]);
      setStudies([]);
      setConferences([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setSignedIn(true);

    const stageRes = await supabase
      .from("pipeline_stages")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });
    let stageRows = stageRes.data;
    const stageError = stageRes.error;

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

    const queryError = stageError ?? studiesRes.error ?? confsRes.error;
    if (queryError) {
      Sentry.captureException(queryError, {
        tags: { module: "pipeline", operation: "refresh" },
      });
      setLoadError("Pipeline could not be loaded. Try refreshing.");
      setStages([]);
      setStudies([]);
      setConferences([]);
    } else {
      setLoadError(null);
      setStages((stageRows ?? []) as PipelineStage[]);
      setStudies((studiesRes.data ?? []) as Study[]);
      setConferences((confsRes.data ?? []) as Conference[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, ["pipeline_stages", "studies", "conferences"], userId, refresh);

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

  const updateStage = useCallback(async (id: string, patch: Partial<Pick<PipelineStage, "name" | "swatch" | "sort_order">>) => {
    const { data, error } = await supabase
      .from("pipeline_stages")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setStages((prev) => prev.map((stage) => (stage.id === id ? (data as PipelineStage) : stage)));
    return { data: data as PipelineStage };
  }, [supabase]);

  const moveStudy = useCallback(async (id: string, stageId: string, sortOrder?: number) => {
    const targetCount = studies.filter((study) => study.stage_id === stageId && study.id !== id).length;
    const nextOrder = sortOrder ?? targetCount;
    const { data, error } = await supabase
      .from("studies")
      .update({ stage_id: stageId, sort_order: nextOrder, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setStudies((prev) => prev.map((study) => (study.id === id ? (data as Study) : study)));
    return { data: data as Study };
  }, [supabase, studies]);

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
    const current = studies.find((study) => study.id === id);
    const stageChanged = patch.stage_id && current && patch.stage_id !== current.stage_id;
    const payload = { ...patch, updated_at: new Date().toISOString() };
    if (stageChanged && patch.stage_id) {
      payload.sort_order = studies.filter((study) => study.stage_id === patch.stage_id && study.id !== id).length;
    }
    const { data, error } = await supabase
      .from("studies")
      .update(payload)
      .eq("id", id)
      .select()
      .single();
    if (error) return { error: error.message };
    setStudies((prev) => prev.map((s) => (s.id === id ? (data as Study) : s)));
    return { data: data as Study };
  }, [supabase, studies]);

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
    loadError,
    signedIn,
    refresh,
    addStage,
    updateStage,
    deleteStage,
    addStudy,
    updateStudy,
    moveStudy,
    deleteStudy,
    addConference,
    updateConference,
    deleteConference,
  };
}
