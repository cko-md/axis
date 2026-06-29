"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

export type LibraryFile = {
  id: string;
  user_id: string;
  storage_path: string;
  display_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  collection: number;
  created_at: string;
};

const BUCKET = "library-files";

export function useLibraryFiles() {
  const supabase = useMemo(() => createClient(), []);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setFiles([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("library_files")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (!error) setFiles((data ?? []) as LibraryFile[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "library_files", userId, refresh);

  const uploadFile = useCallback(async (file: File, collection: number) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: "Sign in to upload files" };

      const storagePath = `${user.id}/${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { contentType: file.type || undefined });
      if (uploadError) return { error: uploadError.message };

      const { data, error: insertError } = await supabase
        .from("library_files")
        .insert({
          user_id: user.id,
          storage_path: storagePath,
          display_name: file.name,
          mime_type: file.type || null,
          size_bytes: file.size,
          collection,
        })
        .select()
        .single();

      if (insertError || !data) {
        // Roll back the orphaned object if the metadata insert failed.
        await supabase.storage.from(BUCKET).remove([storagePath]);
        return { error: insertError?.message ?? "Failed to save file metadata" };
      }

      setFiles((prev) => [data as LibraryFile, ...prev]);
      return { data: data as LibraryFile };
    } catch (err) {
      console.error("[useLibraryFiles] uploadFile", err);
      return { error: "Upload failed" };
    }
  }, [supabase]);

  const deleteFile = useCallback(async (id: string, storagePath: string) => {
    try {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove([storagePath]);
      if (storageError) return { error: storageError.message };

      const { error: dbError } = await supabase.from("library_files").delete().eq("id", id);
      if (dbError) return { error: dbError.message };

      setFiles((prev) => prev.filter((f) => f.id !== id));
      return { ok: true };
    } catch (err) {
      console.error("[useLibraryFiles] deleteFile", err);
      return { error: "Delete failed" };
    }
  }, [supabase]);

  const getDownloadUrl = useCallback(async (storagePath: string) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 10);
    if (error || !data) {
      console.error("[useLibraryFiles] getDownloadUrl", error);
      return null;
    }
    return data.signedUrl;
  }, [supabase]);

  return { files, loading, refresh, uploadFile, deleteFile, getDownloadUrl };
}
