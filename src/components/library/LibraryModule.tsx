"use client";

import { useState } from "react";

const COLLECTIONS = [
  { name: "All Files",       icon: <path d="M3 7l2-3h6l2 3h6v13H3z" /> },
  { name: "Manuscripts",     icon: <path d="M5 3h11l4 4v14H5z" /> },
  { name: "IRB & Regulatory",icon: <><path d="M4 4h16v16H4z" /><path d="M4 9h16" /></> },
  { name: "Figures & Images",icon: <><circle cx="8.5" cy="9" r="1.5" /><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M21 16l-5-5L5 20" /></> },
  { name: "Lectures & Video",icon: <><path d="M5 4h14v16H5z" /><path d="M10 9l5 3-5 3z" /></> },
];

const PHOTOS = [
  { cap: "Lab Retreat · Apr", g: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
  { cap: "Lagos · Dec", g: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
  { cap: "Marathon PR", g: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
  { cap: "OR Day One", g: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
];

// coll[] = which collection indices this file belongs to (0 = All Files always implied)
type FileItem = {
  name: string;
  size: string;
  age: string;
  type?: "pdf" | "doc" | "img";
  label?: string;
  thumbBg?: string;
  video?: boolean;
  colls: number[];
};

const FILES: FileItem[] = [
  { name: "DBS_manuscript_v7.pdf",    size: "2.4 MB", age: "2h",  type: "pdf", label: "PDF",  colls: [1] },
  { name: "Grant_aims_draft.docx",    size: "88 KB",  age: "1d",  type: "doc", label: "DOCX", colls: [1] },
  { name: "IRB_amendment_UIA.pdf",    size: "640 KB", age: "3d",  type: "pdf", label: "PDF",  colls: [2] },
  { name: "KM_curve_recurrence.png",  size: "310 KB", age: "3d",  type: "img", label: "PNG",  colls: [3], thumbBg: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
  { name: "JournalClub_DBS.mp4",      size: "184 MB", age: "1w",  video: true,                colls: [4], thumbBg: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
  { name: "cohort2_dataset.xlsx",     size: "1.1 MB", age: "1w",  type: "doc", label: "XLSX", colls: [2] },
  { name: "cover_letter_JNS.pdf",     size: "72 KB",  age: "2w",  type: "pdf", label: "PDF",  colls: [1] },
  { name: "conference_poster.jpg",    size: "2.0 MB", age: "2w",  type: "img", label: "JPG",  colls: [3], thumbBg: "linear-gradient(135deg,var(--surface-2),var(--surface-3))" },
];

export function LibraryModule() {
  const [activeColl, setActiveColl] = useState(0);
  const visibleFiles = activeColl === 0 ? FILES : FILES.filter((f) => f.colls.includes(activeColl));

  return (
    <>
      <div className="divider" />
      <div className="lib-layout">
        <div>
          <div className="seclabel">Collections</div>
          {COLLECTIONS.map((c, i) => {
            const count = i === 0 ? FILES.length : FILES.filter((f) => f.colls.includes(i)).length;
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
          <div className="dropzone">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <div>
              Drag Files Here, or <span className="accent">Browse</span>
            </div>
            <div className="dz-sub">PDF · DOCX · PNG · JPG · MP4 — up to 5 GB</div>
            <input type="file" multiple />
          </div>
          <div className="seclabel">
            Featured Photos
            <span className="rule" style={{ background: "var(--line)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>Drop images to add</span>
          </div>
          <div className="photostrip">
            {PHOTOS.map((p) => (
              <div key={p.cap} className="photo" style={{ background: p.g }}>
                <div className="ph-cap">{p.cap}</div>
              </div>
            ))}
          </div>
          <div className="seclabel" style={{ marginTop: 22 }}>
            {activeColl === 0 ? "All Files" : COLLECTIONS[activeColl].name}
            <span className="rule" style={{ background: "var(--line)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>{visibleFiles.length} file{visibleFiles.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="filegrid">
            {visibleFiles.map((f) => (
              <div key={f.name} className="file">
                <div className="fthumb" style={f.thumbBg ? { background: f.thumbBg } : undefined}>
                  {f.video ? <div className="vbadge" /> : <span className={`ftype ${f.type}`}>{f.label}</span>}
                </div>
                <div className="fmeta">
                  <div className="fn">{f.name}</div>
                  <div className="fs">
                    <span>{f.size}</span>
                    <span>{f.age}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
