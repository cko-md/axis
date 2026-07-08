"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useLibraryFiles, type LibraryFile } from "@/lib/hooks/useLibraryFiles";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";

const COLLECTIONS = [
  { name: "All Files",       icon: <path d="M3 7l2-3h6l2 3h6v13H3z" /> },
  { name: "Manuscripts",     icon: <path d="M5 3h11l4 4v14H5z" /> },
  { name: "IRB & Regulatory",icon: <><path d="M4 4h16v16H4z" /><path d="M4 9h16" /></> },
  { name: "Figures & Images",icon: <><circle cx="8.5" cy="9" r="1.5" /><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M21 16l-5-5L5 20" /></> },
  { name: "Lectures & Video",icon: <><path d="M5 4h14v16H5z" /><path d="M10 9l5 3-5 3z" /></> },
];

const THUMB_BG = "linear-gradient(135deg,var(--surface-2),var(--surface-3))";

// Derive thumbnail kind/label/video-ness from mime type + file extension —
// real uploads only carry mime_type + display_name, unlike the old mock data.
function fileDisplay(f: LibraryFile): { type?: "pdf" | "doc" | "img"; label?: string; video: boolean; thumbBg?: string } {
  const ext = (f.display_name.split(".").pop() || "").toUpperCase();
  const mime = f.mime_type || "";
  if (mime.startsWith("video/")) return { video: true, thumbBg: THUMB_BG };
  if (mime.startsWith("image/")) return { type: "img", label: ext, video: false, thumbBg: THUMB_BG };
  if (mime === "application/pdf" || ext === "PDF") return { type: "pdf", label: "PDF", video: false };
  if (["DOC", "DOCX", "XLS", "XLSX", "PPT", "PPTX", "TXT", "CSV"].includes(ext)) return { type: "doc", label: ext, video: false };
  return { type: "doc", label: ext || "FILE", video: false };
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function LibraryModule() {
  const [activeColl, setActiveColl] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { files, loading, loadError, uploadFile, deleteFile, getDownloadUrl } = useLibraryFiles();
  const { toast } = useToast();

  const visibleFiles = activeColl === 0 ? files : files.filter((f) => f.collection === activeColl);
  const featuredPhotos = files.filter((f) => f.mime_type?.startsWith("image/")).slice(0, 4);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    featuredPhotos.forEach((p) => {
      if (photoUrls[p.id]) return;
      getDownloadUrl(p.storage_path).then((url) => {
        if (url) setPhotoUrls((prev) => ({ ...prev, [p.id]: url }));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featuredPhotos.map((p) => p.id).join(",")]);

  const handleFiles = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const collection = activeColl;
    const items = Array.from(list);
    for (const file of items) {
      const result = await uploadFile(file, collection);
      if (result.error) toast(result.error, "error", "Library");
    }
    if (items.length > 0) toast(`${items.length} file${items.length !== 1 ? "s" : ""} added`, "success", "Library");
  }, [activeColl, uploadFile, toast]);

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onFileOpen = useCallback(async (f: LibraryFile) => {
    const url = await getDownloadUrl(f.storage_path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else toast("Couldn't open file", "error", "Library");
  }, [getDownloadUrl, toast]);

  const onFileDelete = useCallback(async (e: MouseEvent, f: LibraryFile) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${f.display_name}"? This can't be undone.`)) return;
    const result = await deleteFile(f.id, f.storage_path);
    if (result.error) toast(result.error, "error", "Library");
    else toast("File deleted", "success", "Library");
  }, [deleteFile, toast]);

  return (
    <>
      <div className="divider" />
      {loadError ? (
        <StatusCallout kind="error" title="Library unavailable">{loadError}</StatusCallout>
      ) : loading ? (
        <p style={{ fontSize: 12, color: "var(--ink-faint)", fontFamily: "var(--mono)", marginBottom: 12 }}>Loading files…</p>
      ) : null}
      <div className="lib-layout">
        <div>
          <div className="seclabel">Collections</div>
          {COLLECTIONS.map((c, i) => {
            const count = i === 0 ? files.length : files.filter((f) => f.collection === i).length;
            return (
              <div
                key={c.name}
                className={`coll${activeColl === i ? " on" : ""}`}
                onClick={() => setActiveColl(i)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  {c.icon}
                </svg>
                {c.name}
                <span className="cc">{count}</span>
              </div>
            );
          })}
        </div>
        <div>
          <div
            className={`dropzone${dragOver ? " hot" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <div>
              Drag Files Here, or <span className="accent">Browse</span>
            </div>
            <div className="dz-sub">PDF · DOCX · PNG · JPG · MP4 — up to 5 GB</div>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="seclabel">
            Featured Photos
            <span className="rule" style={{ background: "var(--line)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>Drop images to add</span>
          </div>
          <div className="photostrip">
            {featuredPhotos.length === 0 ? (
              <div className="lib-empty">Drop image files into the dropzone above to feature them here.</div>
            ) : (
              featuredPhotos.map((p) => (
                <div
                  key={p.id}
                  className="photo"
                  role="button"
                  tabIndex={0}
                  onClick={() => onFileOpen(p)}
                  onKeyDown={(e) => e.key === "Enter" && onFileOpen(p)}
                  style={{ background: photoUrls[p.id] ? `url(${photoUrls[p.id]}) center/cover` : THUMB_BG, cursor: "pointer" }}
                >
                  <div className="ph-cap">{p.display_name}</div>
                </div>
              ))
            )}
          </div>
          <div className="seclabel" style={{ marginTop: 22 }}>
            {activeColl === 0 ? "All Files" : COLLECTIONS[activeColl].name}
            <span className="rule" style={{ background: "var(--line)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>{visibleFiles.length} file{visibleFiles.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="filegrid">
            {visibleFiles.map((f) => {
              const disp = fileDisplay(f);
              return (
                <div key={f.id} className="file" onClick={() => onFileOpen(f)}>
                  <div className="fthumb" style={disp.thumbBg ? { background: disp.thumbBg } : undefined}>
                    {disp.video ? <div className="vbadge" /> : <span className={`ftype ${disp.type}`}>{disp.label}</span>}
                    <button
                      type="button"
                      className="fdel"
                      title={`Delete ${f.display_name}`}
                      onClick={(e) => onFileDelete(e, f)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="fmeta">
                    <div className="fn">{f.display_name}</div>
                    <div className="fs">
                      <span>{formatSize(f.size_bytes)}</span>
                      <span>{formatAge(f.created_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {visibleFiles.length === 0 && (
              <div className="lib-empty">No files yet — drag files into the dropzone above, or click Browse.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
