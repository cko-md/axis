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
import { Icon } from "@/components/ui/Icon";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import {
  isEmptyCustomization,
  loadNavCustomizationFromServer,
  saveNavCustomizationToServer,
  type NavCustomization,
} from "@/lib/nav/navCustomizationSync";

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

// Snapshot the four LS keys into the one object we sync to the server.
function readCustomizationSnapshot(): NavCustomization {
  return {
    order: loadNavOrder(),
    groupOrder: loadNavGroupOrder(),
    labels: loadNavLabels(),
    groupLabels: loadNavGroupLabels(),
  };
}

// Mirror a server-loaded customization back into the four LS keys so the
// existing load helpers and save paths keep working unchanged.
function writeCustomizationToLocal(value: NavCustomization) {
  saveNavOrder(value.order);
  saveNavGroupOrder(value.groupOrder);
  saveNavLabels(value.labels);
  saveNavGroupLabels(value.groupLabels);
}

// ─── Nav icons (Lucide via Icon primitive) ───────────────────────────────────

function NavIcon({ name }: { name: string }) {
  return <Icon icon={name} size="sm" aria-hidden />;
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
  href,
  onRename,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  label: string;
  href: string;
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
        href={href}
        prefetch={false}
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
  hrefWithWorkspace,
}: {
  group: NavGroup;
  collapsed: boolean;
  navLabels: Record<string, string>;
  groupLabel: string;
  onItemReorder: (section: string, fromIndex: number, toIndex: number) => void;
  onItemRename: (href: string, newLabel: string) => void;
  onGroupRename: (section: string, newLabel: string) => void;
  pathname: string;
  hrefWithWorkspace: (href: string) => string;
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
                href={hrefWithWorkspace(item.href)}
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
  const { hrefWithWorkspace } = useWorkspace();

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

  // Apply the four LS keys to component state (fast path / signed-out path).
  const applyLocalNav = () => {
    const order = loadNavOrder();
    const groupOrder = loadNavGroupOrder();
    const ordered = applyOrder(DEFAULT_NAV, order);
    setNav(applyGroupOrder(ordered, groupOrder));
    setNavLabels(loadNavLabels());
    setGroupLabels(loadNavGroupLabels());
  };

  // Load persisted nav state: LS first (no flash), then reconcile with the
  // server. If the server has a customization it wins (cross-device); if it
  // has none, a non-empty local one is imported once. Edits made after mount
  // go through the save helpers, which also push to the server.
  const navServerReconciled = useRef(false);
  useEffect(() => {
    applyLocalNav();
    if (navServerReconciled.current) return;
    navServerReconciled.current = true;
    void (async () => {
      const remote = await loadNavCustomizationFromServer();
      if (remote) {
        if (!isEmptyCustomization(remote)) {
          writeCustomizationToLocal(remote);
          applyLocalNav();
        }
        return;
      }
      // No server row: import the local customization once, if there is one.
      const local = readCustomizationSnapshot();
      if (!isEmptyCustomization(local)) saveNavCustomizationToServer(local);
    })();
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
      saveNavCustomizationToServer(readCustomizationSnapshot());
      return next;
    });
  };

  // ── Item rename ────────────────────────────────────────────────────────────
  const handleItemRename = (href: string, newLabel: string) => {
    setNavLabels((prev) => {
      const next = { ...prev, [href]: newLabel };
      saveNavLabels(next);
      saveNavCustomizationToServer(readCustomizationSnapshot());
      return next;
    });
  };

  // ── Group rename ───────────────────────────────────────────────────────────
  const handleGroupRename = (section: string, newLabel: string) => {
    setGroupLabels((prev) => {
      const next = { ...prev, [section]: newLabel };
      saveNavGroupLabels(next);
      saveNavCustomizationToServer(readCustomizationSnapshot());
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
      saveNavCustomizationToServer(readCustomizationSnapshot());
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
                hrefWithWorkspace={hrefWithWorkspace}
              />
            ))}
          </SortableContext>
        </DndContext>

        <UrlModules collapsed={collapsed} openWebViewer={openWebViewer} />
      </nav>

      {/* Spotify strip */}
      <Link
        href={hrefWithWorkspace("/listening-vault")}
        prefetch={false}
        className="spotify"
        title="Open Listening Vault"
      >

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
