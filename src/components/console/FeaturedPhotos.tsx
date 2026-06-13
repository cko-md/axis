"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";

type Photo = { id: string; caption: string; image_url: string; sort_order: number };

const DEFAULT_PHOTOS = [
  { caption: "Lab Retreat · Apr", gradient: "linear-gradient(135deg,#26323f,#10161f)" },
  { caption: "Lagos · Dec", gradient: "linear-gradient(135deg,#2c2738,#10161f)" },
  { caption: "Marathon PR", gradient: "linear-gradient(135deg,#243430,#10161f)" },
  { caption: "OR · Day One", gradient: "linear-gradient(135deg,#312a2a,#10161f)" },
];

export function FeaturedPhotos() {
  const supabase = useMemo(() => createClient(), []);
  const { toast } = useToast();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("console_photos").select("*").eq("user_id", user.id).order("sort_order");
    setPhotos((data ?? []) as Photo[]);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const addPhoto = async (file: File) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast("Sign in to save photos", "error", "Photos");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const image_url = reader.result as string;
      const caption = file.name.replace(/\.[^.]+$/, "").slice(0, 40);
      const { data, error } = await supabase
        .from("console_photos")
        .insert({ user_id: user.id, caption, image_url, sort_order: photos.length })
        .select()
        .single();
      if (error) toast(error.message, "error", "Photos");
      else if (data) {
        setPhotos((p) => [...p, data as Photo]);
        toast("Photo added", "success", "Photos");
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="photostrip-top">
      <div className="pst-head">
        <span>Featured Photos</span>
        <span
          className="pst-connect"
          role="button"
          tabIndex={0}
          onClick={() => toast("Apple Photos / Google Photos integration — Phase 4 stub. Use Add to upload locally.", "info", "Photos")}
        >
          Connect Apple Photos / Google Photos →
        </span>
      </div>
      <div className="pst-rail">
        {photos.length === 0
          ? DEFAULT_PHOTOS.map((p) => (
              <div key={p.caption} className="pst" style={{ background: p.gradient }}>
                <span className="pst-cap">{p.caption}</span>
              </div>
            ))
          : photos.map((p) => (
              <div
                key={p.id}
                className="pst"
                style={{
                  background: p.image_url.startsWith("data:") || p.image_url.startsWith("http")
                    ? `url(${p.image_url}) center/cover`
                    : p.image_url,
                }}
              >
                <span className="pst-cap">{p.caption}</span>
              </div>
            ))}
        <div
          className="pst add"
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>Add</span>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          Array.from(e.target.files ?? []).forEach(addPhoto);
          e.target.value = "";
        }}
      />
    </div>
  );
}
