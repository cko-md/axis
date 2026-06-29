"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

// ─── Storage key ──────────────────────────────────────────────────────────────
const URL_MODULES_KEY = "axis-url-modules";

// ─── Types ───────────────────────────────────────────────────────────────────
type UrlModule = { id: string; name: string; url: string };

const STEP2CK: UrlModule = { id: "step2ck", name: "Step 2 CK Bank", url: "https://step2ck.bank/dashboard" };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadUrlModules(): UrlModule[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(URL_MODULES_KEY) ?? "[]"); }
  catch { return []; }
}

function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { return new URL(withProto).toString(); }
  catch { return null; }
}

// ─── Icons ───────────────────────────────────────────────────────────────────
function NavIcon({ name }: { name: string }) {
  const icons: Record<string, React.ReactNode> = {
    app:   <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9h6v6H9z" /></>,
    add:   <path d="M12 5v14M5 12h14" />,
    board: <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      {icons[name] ?? icons.app}
    </svg>
  );
}

function GripHandle(props: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden
      suppressHydrationWarning
      {...props}
      style={{
        display: "inline-grid",
        gridTemplateColumns: "repeat(2, 3px)",
        gridTemplateRows: "repeat(3, 3px)",
        gap: "2px",
        marginRight: 4,
        flexShrink: 0,
        cursor: "grab",
        color: "var(--ink-faint)",
        opacity: 0,
        transition: "opacity 0.15s",
        ...props.style,
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <span
          key={i}
          style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }}
        />
      ))}
    </span>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────
type Props = {
  collapsed: boolean;
  openWebViewer: (url: string, name: string) => void;
};

export function UrlModules({ collapsed, openWebViewer }: Props) {
  const { toast } = useToast();

  const [urlModules, setUrlModules] = useState<UrlModule[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");

  useEffect(() => {
    setUrlModules(loadUrlModules());
  }, []);

  const persistModules = (mods: UrlModule[]) => {
    setUrlModules(mods);
    try { localStorage.setItem(URL_MODULES_KEY, JSON.stringify(mods)); }
    catch { /* ignore */ }
  };

  const addModule = () => {
    const url = normalizeUrl(formUrl);
    if (!url) { toast("Enter a valid URL", "warn", "Add Module"); return; }
    const name = formName.trim() || new URL(url).host.replace(/^www\./, "");
    persistModules([...urlModules, { id: `m${Date.now().toString(36)}`, name, url }]);
    setFormName(""); setFormUrl(""); setAddOpen(false);
    toast(`${name} added to Apps`, "success", "Add Module");
  };

  const removeModule = (id: string) => persistModules(urlModules.filter((m) => m.id !== id));

  return (
    <>
      {/* Apps section label */}
      {!collapsed && (
        <div className="navlabel" style={{ display: "flex", alignItems: "center" }}>
          <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />
          Apps
        </div>
      )}
      {collapsed && <div style={{ height: 1, background: "var(--line)", margin: "12px 8px" }} />}

      {/* Step2CK built-in link */}
      <button
        type="button"
        className="navitem"
        style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit" }}
        onClick={() => openWebViewer(STEP2CK.url, STEP2CK.name)}
        title="Step 2 CK Bank"
      >
        {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
        <NavIcon name="app" />
        {!collapsed && <span className="lbl">Step 2 CK Bank</span>}
        {!collapsed && <span className="ix">↗</span>}
      </button>

      {/* Dynamic URL modules */}
      {urlModules.map((m) => (
        <button
          key={m.id}
          type="button"
          className="navitem url-module"
          style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit" }}
          onClick={() => openWebViewer(m.url, m.name)}
          title={m.url}
        >
          {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
          <NavIcon name="app" />
          {!collapsed && <span className="lbl">{m.name}</span>}
          {!collapsed && (
            <span
              className="ix url-module-x"
              role="button"
              tabIndex={0}
              title="Remove module"
              onClick={(e) => { e.stopPropagation(); removeModule(m.id); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); removeModule(m.id); } }}
            >
              ✕
            </span>
          )}
        </button>
      ))}

      {/* Add Module button */}
      <button
        type="button"
        className="navitem"
        style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit" }}
        onClick={() => setAddOpen(true)}
        title="Add a module by URL"
      >
        {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
        <NavIcon name="add" />
        {!collapsed && <span className="lbl">Add Module</span>}
      </button>

      {/* New Board button */}
      <button
        type="button"
        className="navitem"
        style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit" }}
        onClick={() => toast("New boards are coming — drag-and-drop board builder is next.", "info", "Boards")}
        title="New Board"
      >
        {!collapsed && <GripHandle style={{ opacity: 0, pointerEvents: "none" }} />}
        <NavIcon name="board" />
        {!collapsed && <span className="lbl">New Board</span>}
        {!collapsed && <span className="ix">✦</span>}
      </button>

      {/* Add Module modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Module"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={addModule}>Add to Apps</Button>
          </>
        }
      >
        <p className="mb-4 text-xs text-[var(--ink-dim)]">
          Pin any web app or tool as a near-fullscreen module. It opens in an embedded window with a one-click escape to a full browser tab.
        </p>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-[var(--ink-faint)]">Name</label>
        <input
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="e.g. UWorld, Anki, ClinicalKey"
          className="mb-3 w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-[var(--ink-faint)]">URL</label>
        <input
          value={formUrl}
          onChange={(e) => setFormUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addModule()}
          placeholder="uworld.com"
          className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
      </Modal>
    </>
  );
}
