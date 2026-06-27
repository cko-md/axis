"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLibraryFiles, type LibraryFile } from "@/lib/hooks/useLibraryFiles";
import { useToast } from "@/components/ui/Toast";

// "Figures & Images" collection in Library — same bucket LibraryModule files
// photo uploads into, so anything added from either surface ends up in the
// same place.
const PHOTOS_COLLECTION = 3;

// Fallback background while a tile's signed URL is loading (or failed to
// resolve) — without this, `background` was left `undefined` and the tile
// rendered as an empty bordered box with no error feedback. Mirrors the
// `.photo`/`.fthumb` gradient fallback LibraryModule already uses.
const THUMB_BG = "linear-gradient(135deg,var(--surface-2),var(--surface-3))";

/**
 * Featured Photos — mirrors the real photo set from the Library module
 * (`library_files` rows whose mime type is image/*) instead of a separate
 * console-only photo store, so anything a user adds in Library shows up
 * here too. Uploading via "Add" here also writes through to Library.
 */
export function FeaturedPhotos() {
  const { toast } = useToast();
  const { files, uploadFile, getDownloadUrl } = useLibraryFiles();
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const photos = useMemo(
    () => files.filter((f) => f.mime_type?.startsWith("image/")).slice(0, 8),
    [files],
  );
  const photoIds = useMemo(() => photos.map((p) => p.id).join(","), [photos]);

  useEffect(() => {
    photos.forEach((p) => {
      if (photoUrls[p.id]) return;
      getDownloadUrl(p.storage_path).then((url) => {
        if (url) setPhotoUrls((prev) => ({ ...prev, [p.id]: url }));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoIds]);

  const addPhoto = async (file: File) => {
    const result = await uploadFile(file, PHOTOS_COLLECTION);
    if (result.error) toast(result.error, "error", "Photos");
    else toast("Photo added — also visible in Library", "success", "Photos");
  };

  const onOpen = async (f: LibraryFile) => {
    const url = photoUrls[f.id] ?? (await getDownloadUrl(f.storage_path));
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else toast("Couldn't open photo", "error", "Photos");
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
        {photos.length === 0 ? (
          <div className="lib-empty" style={{ flex: 1 }}>Drop image files in Library, or use Add here, to feature them.</div>
        ) : (
          photos.map((p) => (
            <div
              key={p.id}
              className="pst"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(p)}
              onKeyDown={(e) => e.key === "Enter" && onOpen(p)}
              style={{ background: photoUrls[p.id] ? `url(${photoUrls[p.id]}) center/cover` : THUMB_BG }}
            >
              <span className="pst-cap">{p.display_name}</span>
            </div>
          ))
        )}
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
