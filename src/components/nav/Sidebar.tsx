"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useSpotify } from "@/components/spotify/SpotifyProvider";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_NAV } from "@/lib/store/nav";
import type { NavGroup } from "@/lib/store/nav";
import { ExternalWindow } from "@/components/layout/ExternalWindow";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

// ─── Storage keys ────────────────────────────────────────────────────────────
const NAV_ORDER_KEY       = "axis-nav-order";
const NAV_GROUP_ORDER_KEY = "axis-nav-group-order";
const NAV_LABELS_KEY      = "axis-nav-labels";
const NAV_GROUP_LABELS_KEY = "axis-nav-group-labels";
const URL_MODULES_KEY     = "axis-url-modules";

// ─── Types ───────────────────────────────────────────────────────────────────
type UrlModule = { id: string; name: string; url: string };

const STEP2CK: UrlModule = { id: "step2ck", name: "Step 2 CK Bank", url: "https://step2ck.bank/dashboard" };

// ─── URL-module helpers ───────────────────────────────────────────────────────
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

// ─── Order / label helpers ────────────────────────────────────────────────────
function loadNavOrder(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(NAV_ORDER_KEY) ?? "{}"); }
  catch { return {}; }
}

function saveNavOrder(order: Record<string, string[]>) {
  try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order)); }
  catch { /* ignore */ }
}

function loadNavGroupOrder(): string[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(NAV_GROUP_ORDER_KEY) ?? "[]"); }
  catch { return []; }
}

function saveNavGroupOrder(order: string[]) {
  try { localStorage.setItem(NAV_GROUP_ORDER_KEY, JSON.stringify(order)); }
  catch { /* ignore */ }
}

function loadNavLabels(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(NAV_LABELS_KEY) ?? "{}"); }
  catch { return {}; }
}

function saveNavLabels(labels: Record<string, string>) {
  try { localStorage.setItem(NAV_LABELS_KEY, JSON.stringify(labels)); }
  catch { /* ignore */ }
}

function loadNavGroupLabels(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(NAV_GROUP_LABELS_KEY) ?? "{}"); }
  catch { return {}; }
}

function saveNavGroupLabels(labels: Record<string, string>) {
  try { localStorage.setItem(NAV_GROUP_LABELS_KEY, JSON.stringify(labels)); }
  catch { /* ignore */ }
}

function applyOrder(nav: typeof DEFAULT_NAV, order: Record<string, string[]>): typeof DEFAULT_NAV {
  return nav.map((group) => {
    const ord = order[group.section];
    if (!ord?.length) return group;
    const items = [...group.items].sort((a, b) => {
      const ai = ord.indexOf(a.href);
      const bi = ord.indexOf(b.href);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    return { ...group, items };
  });
}

function applyGroupOrder(nav: typeof DEFAULT_NAV, order: string[]): typeof DEFAULT_NAV {
  if (!order.length) return nav;
  return [...nav].sort((a, b) => {
    const ai = order.indexOf(a.section);
    const bi = order.indexOf(b.section);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// ─── SVG Icons ───────────────────────────────────────────────────────────────
const ICONS: Record<string, React.ReactNode> = {
  console:    <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  signals:    <path d="M3 13h5l2 3h4l2-3h5M5 6h14l2 7v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" />,
  calendar:   <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></>,
  agenda:     <path d="M4 6h16M4 12h16M4 18h10" />,
  mail:       <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  notes:      <><path d="M5 3h11l4 4v14H5z" /><path d="M9 8h7M9 12h7M9 16h4" /></>,
  goals:      <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 1v3M12 20v3" /></>,
  review:     <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4" />,
  pipeline:   <path d="M4 5h16M4 5v14M4 19h16M9 9h7M9 13h5" />,
  literature: <path d="M4 4h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-1H4zM20 4h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-1h7z" />,
  fitness:    <path d="M6 6v12M18 6v12M6 12h12M3 9v6M21 9v6" />,
  atelier:    <path d="M3 21l4-1 11-11-3-3L4 17zM14 6l3 3" />,
  people:     <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-5" /></>,
  briefing:   <><path d="M4 5h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M8 9h7M8 13h5" /></>,
  vault:      <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.6" /><path d="M12 3v3M12 18v3" /></>,
  library:    <path d="M3 7l2-3h6l2 3h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />,
  recipes:    <path d="M6 3v18M6 5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6M10 9h6M10 13h6" />,
  chart:      <path d="M4 19V5M4 19h16M8 15l3-4 3 3 4-6" />,
  gallery:    <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 15l5-5 4 4 3-3 6 6" /></>,
  system:     <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.7a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.7a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></>,
  app:        <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9h6v6H9z" /></>,
  add:        <path d="M12 5v14M5 12h14" />,
  board:      <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />,
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      {ICONS[name] ?? ICONS.chart}
    </svg>
  );
}

// ─── Grip handle (6-dot, 2×3 grid) ───────────────────────────────────────────
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

// ─── Inline rename input ──────────────────────────────────────────────────────
function InlineRename({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    ref.current?.select();
  }, []);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        // prevent dnd-kit from intercepting keyboard
        e.stopPropagation();
      }}
      // stop clicks inside from bubbling to Link/button
      onClick={(e) => e.preventDefault()}
      style={{
        background: "none",
        border: "none",
        borderBottom: "1px solid var(--accent)",
        color: "var(--ink)",
        font: "inherit",
        fontSize: "inherit",
        lineHeight: "inherit",
        padding: 0,
        margin: 0,
        width: "100%",
        outline: "none",
        minWidth: 0,
      }}
    />
  );
}

// ─── Sortable nav item ────────────────────────────────────────────────────────
function SortableNavItem({
  item,
  active,
  collapsed,
  label,
  onRename,
}: {
  item: { href: string; label: string; icon: string; title?: string; ix?: string };
  active: boolean;
  collapsed: boolean;
  label: string;
  onRename: (href: string, newLabel: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.href });

  const [renaming, setRenaming] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: "relative" as const,
  };

  // We need hover state to reveal the grip
  const [hovered, setHovered] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={style}
      suppressHydrationWarning
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link
        href={item.href}
        className={`navitem${active ? " active" : ""}`}
        title={item.title ?? item.label}
        // prevent navigation while renaming
        onClick={renaming ? (e) => e.preventDefault() : undefined}
      >
        {!collapsed && (
          <GripHandle
            {...listeners}
            {...attributes}
            style={{ opacity: hovered && !renaming ? 1 : 0 }}
          />
        )}
        <NavIcon name={item.icon} />
        {!collapsed && (
          renaming ? (
            <InlineRename
              value={label}
              onCommit={(v) => { onRename(item.href, v); setRenaming(false); }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span
              className="lbl"
              onDoubleClick={(e) => { e.preventDefault(); setRenaming(true); }}
              title="Double-click to rename"
            >
              {label}
            </span>
          )
        )}
        {!collapsed && !renaming && item.ix && <span className="ix">{item.ix}</span>}
      </Link>
    </div>
  );
}

// ─── Sortable group ───────────────────────────────────────────────────────────
function SortableNavGroup({
  group,
  collapsed,
  navLabels,
  groupLabel,
  onItemReorder,
  onItemRename,
  onGroupRename,
  pathname,
}: {
  group: NavGroup;
  collapsed: boolean;
  navLabels: Record<string, string>;
  groupLabel: string;
  onItemReorder: (section: string, fromIndex: number, toIndex: number) => void;
  onItemRename: (href: string, newLabel: string) => void;
  onGroupRename: (section: string, newLabel: string) => void;
  pathname: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: group.section });

  const [renamingGroup, setRenamingGroup] = useState(false);
  const [groupHovered, setGroupHovered] = useState(false);

  const groupStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function onItemDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const items = group.items;
    const oldIndex = items.findIndex((i) => i.href === active.id);
    const newIndex = items.findIndex((i) => i.href === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      onItemReorder(group.section, oldIndex, newIndex);
    }
  }

  return (
    <div ref={setNodeRef} style={groupStyle} suppressHydrationWarning>
      {!collapsed && (
        <div
          className="navlabel"
          onMouseEnter={() => setGroupHovered(true)}
          onMouseLeave={() => setGroupHovered(false)}
          style={{ display: "flex", alignItems: "center" }}
        >
          <GripHandle
            {...listeners}
            {...attributes}
            style={{ opacity: groupHovered && !renamingGroup ? 1 : 0, marginRight: 4 }}
          />
          {renamingGroup ? (
            <InlineRename
              value={groupLabel}
              onCommit={(v) => { onGroupRename(group.section, v); setRenamingGroup(false); }}
              onCancel={() => setRenamingGroup(false)}
            />
          ) : (
            <span
              onDoubleClick={() => setRenamingGroup(true)}
              title="Double-click to rename"
              style={{ cursor: "default" }}
            >
              {groupLabel}
            </span>
          )}
        </div>
      )}
      {collapsed && (
        <div style={{ height: 1, background: "var(--line)", margin: "12px 8px" }} />
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onItemDragEnd}
        autoScroll={false}
      >
        <SortableContext
          items={group.items.map((i) => i.href)}
          strategy={verticalListSortingStrategy}
        >
          {group.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <SortableNavItem
                key={item.href}
                item={item}
                active={active}
                collapsed={collapsed}
                label={navLabels[item.href] ?? item.label}
                onRename={onItemRename}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────
type Props = {
  collapsed: boolean;
  onToggle: () => void;
};

export function Sidebar({ collapsed, onToggle }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();

  const [external, setExternal] = useState<UrlModule | null>(null);
  const [urlModules, setUrlModules] = useState<UrlModule[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");

  const [nav, setNav] = useState(DEFAULT_NAV);
  const [navLabels, setNavLabels] = useState<Record<string, string>>({});
  const [groupLabels, setGroupLabels] = useState<Record<string, string>>({});

  const [profile, setProfile] = useState<{ name: string; role: string } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: "", role: "", bio: "", photo: "" });
  const [profileSaving, setProfileSaving] = useState(false);
  const spotify = useSpotify();
  const supabase = useMemo(() => createClient(), []);

  // Load all persisted state on mount
  useEffect(() => {
    const order = loadNavOrder();
    const groupOrder = loadNavGroupOrder();
    const ordered = applyOrder(DEFAULT_NAV, order);
    setNav(applyGroupOrder(ordered, groupOrder));
    setNavLabels(loadNavLabels());
    setGroupLabels(loadNavGroupLabels());
    setUrlModules(loadUrlModules());
  }, []);

  // ── Profile ────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setProfile(null); return; }
      const { data } = await supabase
        .from("profiles")
        .select("display_name, role_title, bio, avatar_url")
        .eq("id", user.id)
        .maybeSingle();
      const name = data?.display_name || user.email?.split("@")[0] || "Account";
      const role = data?.role_title || user.email || "";
      setProfile({ name, role });
      setProfileForm({
        name,
        role,
        bio: data?.bio ?? "",
        photo: data?.avatar_url ?? "",
      });
    })();
  }, [supabase]);

  const saveProfile = async () => {
    setProfileSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("profiles").upsert({
        id: user.id,
        display_name: profileForm.name.trim(),
        role_title: profileForm.role.trim(),
        bio: profileForm.bio.trim(),
        avatar_url: profileForm.photo.trim(),
        updated_at: new Date().toISOString(),
      });
      setProfile({ name: profileForm.name.trim() || "Account", role: profileForm.role.trim() });
      setProfileOpen(false);
      toast("Profile saved", "success", "Profile");
    } catch {
      toast("Could not save profile", "error", "Profile");
    } finally {
      setProfileSaving(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  // ── URL modules ────────────────────────────────────────────────────────────
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

  // ── Item reorder ───────────────────────────────────────────────────────────
  const handleItemReorder = (section: string, fromIndex: number, toIndex: number) => {
    setNav((prev) => {
      const next = prev.map((g) => {
        if (g.section !== section) return g;
        return { ...g, items: arrayMove(g.items, fromIndex, toIndex) };
      });
      // Persist
      const order = loadNavOrder();
      const group = next.find((g) => g.section === section);
      if (group) order[section] = group.items.map((i) => i.href);
      saveNavOrder(order);
      return next;
    });
  };

  // ── Item rename ────────────────────────────────────────────────────────────
  const handleItemRename = (href: string, newLabel: string) => {
    setNavLabels((prev) => {
      const next = { ...prev, [href]: newLabel };
      saveNavLabels(next);
      return next;
    });
  };

  // ── Group rename ───────────────────────────────────────────────────────────
  const handleGroupRename = (section: string, newLabel: string) => {
    setGroupLabels((prev) => {
      const next = { ...prev, [section]: newLabel };
      saveNavGroupLabels(next);
      return next;
    });
  };

  // ── Group reorder ──────────────────────────────────────────────────────────
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const onGroupDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setNav((prev) => {
      const oldIndex = prev.findIndex((g) => g.section === active.id);
      const newIndex = prev.findIndex((g) => g.section === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      saveNavGroupOrder(next.map((g) => g.section));
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="sb-top">
        <div className="mark">
          <svg viewBox="0 0 30 30" fill="none" style={{ width: 30, height: 30 }}>
            <circle cx="23.5" cy="7.5" r="6" fill="rgba(255,155,60,.45)" />
            <circle cx="23.5" cy="7.5" r="2.1" fill="#FF8C3A" />
            <path d="M3 24 L11 9 L16.5 18 L20 12.5 L27 24" stroke="#16B8F3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 24 H27" stroke="#9aa7b8" strokeWidth="1.1" strokeLinecap="round" opacity=".7" />
          </svg>
        </div>
        {!collapsed && (
          <div className="wordmark">
            A<span>XIS</span>
            <sup className="tm">[CKO]</sup>
          </div>
        )}
        <button type="button" className="toggle" onClick={onToggle} title="Collapse sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 14, height: 14, transform: collapsed ? "rotate(180deg)" : undefined }}>
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>

      <nav className="nav">
        <DndContext
          sensors={groupSensors}
          collisionDetection={closestCenter}
          onDragEnd={onGroupDragEnd}
          autoScroll={false}
        >
          <SortableContext
            items={nav.map((g) => g.section)}
            strategy={verticalListSortingStrategy}
          >
            {nav.map((group) => (
              <SortableNavGroup
                key={group.section}
                group={group}
                collapsed={collapsed}
                navLabels={navLabels}
                groupLabel={groupLabels[group.section] ?? group.section}
                onItemReorder={handleItemReorder}
                onItemRename={handleItemRename}
                onGroupRename={handleGroupRename}
                pathname={pathname}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Apps section — static, not sortable */}
        {!collapsed && <div className="navlabel">Apps</div>}
        {collapsed && <div style={{ height: 1, background: "var(--line)", margin: "12px 8px" }} />}

        <button
          type="button"
          className="navitem"
          style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", paddingLeft: collapsed ? 10 : 22 }}
          onClick={() => setExternal(STEP2CK)}
          title="Step 2 CK Bank"
        >
          <NavIcon name="app" />
          {!collapsed && <span className="lbl">Step 2 CK Bank</span>}
          {!collapsed && <span className="ix">↗</span>}
        </button>

        {urlModules.map((m) => (
          <button
            key={m.id}
            type="button"
            className="navitem url-module"
            style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", paddingLeft: collapsed ? 10 : 22 }}
            onClick={() => setExternal(m)}
            title={m.url}
          >
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

        <button
          type="button"
          className="navitem"
          style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", paddingLeft: collapsed ? 10 : 22 }}
          onClick={() => setAddOpen(true)}
          title="Add a module by URL"
        >
          <NavIcon name="add" />
          {!collapsed && <span className="lbl">Add Module</span>}
        </button>

        <button
          type="button"
          className="navitem"
          style={{ width: "100%", background: "none", border: "none", textAlign: "left", font: "inherit", paddingLeft: collapsed ? 10 : 22 }}
          onClick={() => toast("New boards are coming — drag-and-drop board builder is next.", "info", "Boards")}
          title="New Board"
        >
          <NavIcon name="board" />
          {!collapsed && <span className="lbl">New Board</span>}
          {!collapsed && <span className="ix">✦</span>}
        </button>
      </nav>

      <Link href="/listening-vault" className="spotify" title="Open Listening Vault">
        <div className="sp-art">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="11" fill="#1db954" />
            <path d="M7 10c3-1 7-.5 9 1M7.5 13c2.5-.8 5.5-.4 7 .8M8 15.5c2-.6 4-.3 5 .5" stroke="#0a0a0a" strokeWidth="1.1" fill="none" strokeLinecap="round" />
          </svg>
        </div>
        <div className="sp-meta">
          <div className="sp-t">{spotify.connected ? spotify.track : "Not connected"}</div>
          <div className="sp-a">{spotify.connected ? spotify.artist : "Connect · Spotify"}</div>
        </div>
        <div className="sp-ctrl" onClick={(e) => e.preventDefault()}>
          <button
            type="button"
            aria-label="Play"
            onClick={(e) => { e.preventDefault(); if (spotify.connected) spotify.togglePlay(); else spotify.connect(); }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d={spotify.playing ? "M6 5h4v14H6zM14 5h4v14h-4z" : "M8 5v14l11-7z"} />
            </svg>
          </button>
          <button type="button" aria-label="Next track" onClick={(e) => { e.preventDefault(); spotify.next(); }}>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5v14M9 12l9-7v14z" /></svg>
          </button>
        </div>
      </Link>

      {!collapsed && (
        <div className="sidefoot">
          {profile ? (
            <div className="profile" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => setProfileOpen(true)} title="Edit profile">
              {profileForm.photo ? (
                <img src={profileForm.photo} alt={profile.name} className="avatar" style={{ objectFit: "cover", borderRadius: "50%" }} />
              ) : (
                <div className="avatar">{profile.name[0]?.toUpperCase() ?? "A"}</div>
              )}
              <div className="pmeta">
                <div className="pn">{profile.name}</div>
                <div className="pr">{profile.role}</div>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void signOut(); }}
                title="Sign out"
                aria-label="Sign out"
                style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", padding: 4 }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 14, height: 14 }}>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            </div>
          ) : (
            <Link href="/login" className="profile">
              <div className="avatar">→</div>
              <div className="pmeta">
                <div className="pn">Sign in</div>
                <div className="pr">Sync across devices</div>
              </div>
            </Link>
          )}
        </div>
      )}

      {external && (
        <ExternalWindow title={external.name} url={external.url} onClose={() => setExternal(null)} />
      )}

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

      {/* Profile modal */}
      <Modal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="Profile"
        footer={
          <>
            <Button variant="ghost" onClick={() => setProfileOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void saveProfile()} disabled={profileSaving}>
              {profileSaving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        {profileForm.photo && (
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
            <img
              src={profileForm.photo}
              alt="Profile"
              style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", border: "2px solid var(--line)" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        )}
        {(["name", "role", "photo"] as const).map((field) => (
          <div key={field} style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 5 }}>
              {field === "photo" ? "Photo URL" : field === "name" ? "Display Name" : "Role / Title"}
            </label>
            <input
              value={profileForm[field]}
              onChange={(e) => setProfileForm((p) => ({ ...p, [field]: e.target.value }))}
              placeholder={field === "name" ? "Your name" : field === "role" ? "Resident Physician, Neurosurgery" : "https://…"}
              className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        ))}
        <div>
          <label style={{ display: "block", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 5 }}>
            Bio
          </label>
          <textarea
            value={profileForm.bio}
            onChange={(e) => setProfileForm((p) => ({ ...p, bio: e.target.value }))}
            placeholder="A short bio or description…"
            rows={3}
            style={{ width: "100%", padding: "8px 12px", borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface-2)", color: "var(--ink)", fontFamily: "var(--sans)", fontSize: 13, resize: "vertical", outline: "none" }}
          />
        </div>
      </Modal>
    </aside>
  );
}
