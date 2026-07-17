"use client";

import { useCallback, useEffect, useState } from "react";
import type { FinancialProfileInput, MemoryCreateInput, MemoryUpdateInput } from "@/lib/memory/contracts";

export type MemoryItem = {
  id: string;
  kind: MemoryCreateInput["kind"];
  scope: MemoryCreateInput["scope"];
  content: string;
  source_type: "user_asserted" | "provider_import" | "system_observed";
  source_ref: string | null;
  confidence_bps: number;
  status: "active" | "archived";
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type FinancialOperatingProfile = FinancialProfileInput & {
  user_id: string;
  source_type: "user_asserted";
  confirmed_at: string;
  created_at: string;
  updated_at: string;
};

type MutationResult<T> = { ok: true; data: T } | { ok: false; reason: string };

async function errorCode(response: Response | null, fallback: string) {
  if (!response) return "NETWORK";
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}
export function useMemoryCenter(status: "active" | "archived") {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [profile, setProfile] = useState<FinancialOperatingProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [memoryResponse, profileResponse] = await Promise.all([
        fetch(`/api/memory?status=${status}`),
        fetch("/api/financial-profile"),
      ]);
      if (memoryResponse.status === 401 || profileResponse.status === 401) {
        setItems([]);
        setProfile(null);
        setError("SIGNED_OUT");
        return;
      }
      if (!memoryResponse.ok || !profileResponse.ok) throw new Error("LOAD_FAILED");
      const [memoryBody, profileBody] = await Promise.all([memoryResponse.json(), profileResponse.json()]);
      setItems(Array.isArray(memoryBody.items) ? memoryBody.items : []);
      setProfile(profileBody.profile ?? null);
    } catch {
      setError("LOAD_FAILED");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void reload(); }, [reload]);

  const createMemory = useCallback(async (input: MemoryCreateInput): Promise<MutationResult<MemoryItem>> => {
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).catch(() => null);
    if (!response?.ok) return { ok: false, reason: await errorCode(response, "MEMORY_CREATE_FAILED") };
    const body = await response.json();
    const item = body.item as MemoryItem;
    if (status === "active") setItems((current) => [item, ...current]);
    return { ok: true, data: item };
  }, [status]);

  const updateMemory = useCallback(async (id: string, input: MemoryUpdateInput): Promise<MutationResult<MemoryItem>> => {
    const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).catch(() => null);
    if (!response?.ok) return { ok: false, reason: await errorCode(response, "MEMORY_UPDATE_FAILED") };
    const body = await response.json();
    const item = body.item as MemoryItem;
    setItems((current) => item.status === status
      ? current.map((entry) => entry.id === id ? item : entry)
      : current.filter((entry) => entry.id !== id));
    return { ok: true, data: item };
  }, [status]);

  const archiveMemory = useCallback(async (id: string): Promise<MutationResult<MemoryItem>> => {
    const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) return { ok: false, reason: await errorCode(response, "MEMORY_ARCHIVE_FAILED") };
    const body = await response.json();
    const item = body.item as MemoryItem;
    setItems((current) => current.filter((entry) => entry.id !== id));
    return { ok: true, data: item };
  }, []);

  const saveProfile = useCallback(async (input: FinancialProfileInput): Promise<MutationResult<FinancialOperatingProfile>> => {
    const response = await fetch("/api/financial-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).catch(() => null);
    if (!response?.ok) return { ok: false, reason: await errorCode(response, "PROFILE_SAVE_FAILED") };
    const body = await response.json();
    const saved = body.profile as FinancialOperatingProfile;
    setProfile(saved);
    return { ok: true, data: saved };
  }, []);

  return { items, profile, loading, error, reload, createMemory, updateMemory, archiveMemory, saveProfile };
}
