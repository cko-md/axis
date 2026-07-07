"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
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
import { useRef } from "react";
import { useSpotify } from "@/components/spotify/SpotifyProvider";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_NAV } from "@/lib/store/nav";
import type { NavGroup, NavItem } from "@/lib/store/nav";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { ProfileSection, profileInitials } from "@/components/nav/ProfileSection";
import { UrlModules } from "@/components/nav/UrlModules";

// ─── Storage keys ────────────────────────────────────────────────────────────
const NAV_ORDER_KEY       = "axis-nav-order";
const NAV_GROUP_ORDER_KEY = "axis-nav-group-order";
const NAV_LABELS_KEY      = "axis-nav-labels";
const NAV_GROUP_LABELS_KEY = "axis-nav-group-labels";

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

function NavStatusBadge({ status }: { status?: NavItem["status"] }) {
  if (!status || status === "production") return null;
  const label = status === "beta" ? "BETA" : status === "lab" ? "LAB" : "SOON";
  const color = status === "beta" ? "var(--accent-2)" : status === "lab" ? "var(--clay)" : "var(--ink-faint)";
  return (
    <span
      style={{
        marginLeft: "auto",
        fontSize: 8,
        fontFamily: "var(--mono)",
        letterSpacing: ".08em",
        color,
      }}
    >
      {label}
    </span>
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
        e.stopPropagation();
      }}
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
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  label: string;
  onRename: (href: string, newLabel: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.href });

  const [renaming, setRenaming] = useState(false);
  const [hovered, setHovered] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: "relative" as const,
  };

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
        {!collapsed && !renaming && !item.ix && <NavStatusBadge status={item.status} />}
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
        id="sidebar-items"
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
};

export function Sidebar({ collapsed }: Props) {
  const pathname = usePathname();
  const router = useRouter();

  const { open: openWebViewer } = useWebViewer();
  const spotify = useSpotify();

  const [profileName, setProfileName] = useState<string | undefined>(undefined);

  const [nav, setNav] = useState(DEFAULT_NAV);
  const [navLabels, setNavLabels] = useState<Record<string, string>>({});
  const [groupLabels, setGroupLabels] = useState<Record<string, string>>({});

  const [sunHour, setSunHour] = useState(() => {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  });
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setSunHour(d.getHours() + d.getMinutes() / 60);
    };
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  // Load all persisted nav state on mount
  useEffect(() => {
    const order = loadNavOrder();
    const groupOrder = loadNavGroupOrder();
    const ordered = applyOrder(DEFAULT_NAV, order);
    setNav(applyGroupOrder(ordered, groupOrder));
    setNavLabels(loadNavLabels());
    setGroupLabels(loadNavGroupLabels());
  }, []);

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  // ── Item reorder ───────────────────────────────────────────────────────────
  const handleItemReorder = (section: string, fromIndex: number, toIndex: number) => {
    setNav((prev) => {
      const next = prev.map((g) => {
        if (g.section !== section) return g;
        return { ...g, items: arrayMove(g.items, fromIndex, toIndex) };
      });
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
          {(() => {
            const isDay = sunHour >= 6 && sunHour < 18;
            const sunT = Math.max(0, Math.min(1, (sunHour - 6) / 12));
            const moonHour = sunHour >= 18 ? sunHour - 18 : sunHour + 6;
            const moonT = Math.max(0, Math.min(1, moonHour / 12));
            const arcX = (t: number) => 3 + t * 24;
            const arcY = (t: number) => Math.round((24 - Math.sin(Math.PI * t) * 17) * 1e6) / 1e6;
            const sx = arcX(sunT); const sy = arcY(sunT);
            const mx = arcX(moonT); const my = arcY(moonT);
            return (
              <svg viewBox="0 0 30 30" fill="none" style={{ width: 30, height: 30 }}>
                <defs>
                  <linearGradient id="mtnGrad" x1="15" y1="24" x2="15" y2="9" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="white" stopOpacity="0.85" />
                    <stop offset="100%" stopColor="#16B8F3" />
                  </linearGradient>
                </defs>
                {isDay && <>
                  <circle cx={sx} cy={sy} r="6" fill="rgba(255,140,50,.38)" className="sun-aura" />
                  <circle cx={sx} cy={sy} r="2.2" fill="#FF8C3A" className="sun-core" />
                </>}
                {!isDay && <>
                  <circle cx={mx} cy={my} r="6" fill="rgba(180,210,255,.16)" className="moon-aura" />
                  <circle cx={mx} cy={my} r="2.2" fill="#d4e8ff" />
                </>}
                {(() => {
                  const op = sunHour >= 20 || sunHour < 4 ? 1 :
                    sunHour >= 18 ? (sunHour - 18) / 2 :
                    sunHour < 6 ? (6 - sunHour) / 2 : 0;
                  return op > 0 ? (
                    <g opacity={op}>
                      <circle cx="4.5" cy="5" r="0.6" fill="white" className="logo-star ls1" />
                      <circle cx="16" cy="3" r="0.5" fill="white" className="logo-star ls2" />
                      <circle cx="26" cy="5" r="0.65" fill="white" className="logo-star ls3" />
                      <circle cx="9" cy="14" r="0.5" fill="white" className="logo-star ls4" />
                      <circle cx="23" cy="15" r="0.55" fill="white" className="logo-star ls5" />
                      <circle cx="28.5" cy="12" r="0.5" fill="white" className="logo-star ls6" />
                    </g>
                  ) : null;
                })()}
                <path d="M3 24 L11 9 L16.5 18 L20 12.5 L27 24" stroke="url(#mtnGrad)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 24 H27" stroke="#9aa7b8" strokeWidth="1.1" strokeLinecap="round" opacity=".7" />
              </svg>
            );
          })()}
        </div>
        {!collapsed && (
          <div className="wordmark">
            AXIS
            <sup className="tm">[{profileInitials(profileName)}]</sup>
          </div>
        )}
      </div>

      <nav className="nav">
        <DndContext
          id="sidebar-groups"
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

        <UrlModules collapsed={collapsed} openWebViewer={openWebViewer} />
      </nav>

      {/* Spotify strip */}
      <Link href="/listening-vault" className="spotify" title="Open Listening Vault">
        <div className="sp-art">
          {spotify.connected && spotify.now.art ? (
            <Image
              src={spotify.now.art}
              alt=""
              width={34}
              height={34}
              unoptimized
              style={{ width: 34, height: 34, borderRadius: 3, objectFit: "cover", display: "block" }}
            />
          ) : (
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="11" fill="#1db954" />
              <path d="M7 10c3-1 7-.5 9 1M7.5 13c2.5-.8 5.5-.4 7 .8M8 15.5c2-.6 4-.3 5 .5" stroke="#0a0a0a" strokeWidth="1.1" fill="none" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <div className="sp-meta">
          <div className="sp-t">{spotify.connected ? spotify.track : "Not Connected"}</div>
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

      {/* Profile section (sidefoot + modal) */}
      {!collapsed && (
        <ProfileSection onSignOut={signOut} onProfileName={setProfileName} />
      )}
    </aside>
  );
}
