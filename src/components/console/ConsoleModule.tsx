"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/components/theme/ThemeProvider";
import { DEFAULT_WIDGET_IDS, getWidgetById, WIDGET_CATALOG, normalizeConsoleLayout, BLOCK_SIZES, type BlockSize } from "@/lib/store/widgets";
import { formatDateLong } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { FeaturedPhotos } from "@/components/console/FeaturedPhotos";
import { useWidgetData } from "@/lib/hooks/useWidgetData";
import { isSignalActionable, isSignalVisible, useSignals } from "@/lib/hooks/useSignals";
import { rankTasks, useTasks, type Task } from "@/lib/hooks/useTasks";
import { useNotes } from "@/lib/hooks/useNotes";
import { usePeople } from "@/lib/hooks/usePeople";
import { Card } from "@/components/ui/Card";
import { WidgetActionMenu, WidgetDetailDrawer, WidgetShell } from "@/components/widgets";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetStatus } from "@/lib/widgets/types";

/* ── widget icons ──────────────────────────────────────────────── */

const W = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props} />
);

const WIDGET_ICONS: Record<string, React.ReactNode> = {
  weather: <W><circle cx="8" cy="8" r="2.8"/><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/><line x1="3.4" y1="3.4" x2="4.4" y2="4.4"/><line x1="11.6" y1="11.6" x2="12.6" y2="12.6"/><line x1="3.4" y1="12.6" x2="4.4" y2="11.6"/><line x1="11.6" y1="4.4" x2="12.6" y2="3.4"/></W>,
  daylight: <W><path d="M2 11 a6 6 0 0 1 12 0"/><line x1="8" y1="2.5" x2="8" y2="4"/><line x1="2.4" y1="7" x2="3.7" y2="7.7"/><line x1="13.6" y1="7" x2="12.3" y2="7.7"/><line x1="1" y1="11" x2="15" y2="11"/></W>,
  air: <W><path d="M2 5.5 h7 a2.5 2.5 0 0 1 0 5"/><path d="M2 8.5 h5 a2 2 0 0 1 0 4"/><line x1="2" y1="11.5" x2="5" y2="11.5"/></W>,
  agenda: <W strokeWidth="1.3"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><line x1="2.5" y1="7" x2="13.5" y2="7"/><line x1="5.5" y1="2" x2="5.5" y2="5"/><line x1="10.5" y1="2" x2="10.5" y2="5"/><rect x="5" y="9" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/><rect x="9" y="9" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/></W>,
  markets: <W><polyline points="2,12 5.5,8.5 8.5,10 13.5,4.5"/><polyline points="10.5,4.5 13.5,4.5 13.5,7.5"/></W>,
  run: <W><polyline points="9.5,2 5,9 8.5,9 6.5,14 12,7 8.5,7"/></W>,
  sleep: <W><path d="M12.5 11.5 A5.5 5.5 0 1 1 4.5 3.5 A4 4 0 0 0 12.5 11.5Z"/></W>,
  hrv: <W><polyline points="1,8 4,8 5.5,5 7,11 8.5,6.5 10,9.5 11.5,8 15,8"/></W>,
  heartrate: <W><path d="M8 13 C6 11 2 8.5 2 5.5 A3 3 0 0 1 8 4.2 A3 3 0 0 1 14 5.5 C14 8.5 10 11 8 13Z"/></W>,
  vo2max: <W><path d="M8 4 v8"/><path d="M8 6.5 C8 6.5 4.5 6.5 4.5 9.5 C4.5 11.5 6 12.5 8 11.5"/><path d="M8 6.5 C8 6.5 11.5 6.5 11.5 9.5 C11.5 11.5 10 12.5 8 11.5"/></W>,
  hydration: <W><path d="M8 2 C8 2 3.5 8 3.5 11 A4.5 4.5 0 0 0 12.5 11 C12.5 8 8 2 8 2Z"/><line x1="6" y1="11" x2="7" y2="9" strokeWidth="1" opacity="0.7"/></W>,
  location: <W><path d="M8 1.5 A4 4 0 0 1 12 5.5 C12 9 8 14.5 8 14.5 C8 14.5 4 9 4 5.5 A4 4 0 0 1 8 1.5Z"/><circle cx="8" cy="5.5" r="1.5" fill="currentColor" stroke="none"/></W>,
};

function WidgetIcon({ id }: { id: string }) {
  return WIDGET_ICONS[id] ?? WIDGET_ICONS.agenda;
}

function widgetIconStyle(id: string, raw?: Record<string, unknown>): { background: string; color: string } {
  if (id === "air") {
    const aqi = (raw?.aqi as number) ?? 0;
    if (aqi <= 50) return { background: "color-mix(in srgb, #7fa86a 14%, transparent)", color: "var(--sage, #7fa86a)" };
    if (aqi <= 100) return { background: "color-mix(in srgb, #c9a463 14%, transparent)", color: "var(--gold-2)" };
    return { background: "color-mix(in srgb, #c2603f 14%, transparent)", color: "var(--clay, #c2603f)" };
  }
  if (id === "markets") {
    const chg = (raw?.chg as number) ?? 0;
    if (chg > 0) return { background: "color-mix(in srgb, #7fa86a 12%, transparent)", color: "var(--up)" };
    if (chg < 0) return { background: "color-mix(in srgb, #c2603f 12%, transparent)", color: "var(--down)" };
  }
  return { background: "color-mix(in srgb, var(--gold) 12%, transparent)", color: "var(--gold-2)" };
}

function WidgetSecondLine({ id, raw }: { id: string; raw?: Record<string, unknown> }) {
  if (!raw) return null;
  if (id === "weather" && raw.humidity !== undefined) {
    return <div className="tb-raw">Humidity {String(raw.humidity)}%</div>;
  }
  if (id === "air" && raw.uv !== undefined) {
    const aqi = raw.aqi as number;
    const label = aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" : "Poor";
    return <div className="tb-raw">AQI {aqi} · UV {String(raw.uv)} · {label}</div>;
  }
  if (id === "markets" && raw.chg !== undefined) {
    const sign = (raw.chg as number) >= 0 ? "▴" : "▾";
    return <div className="tb-raw">SPY {sign}{Math.abs(raw.chg as number).toFixed(2)}%</div>;
  }
  if (id === "run" && raw.km !== undefined) {
    return <div className="tb-raw">{String(raw.km)} km this week · {Number(raw.streak) > 0 ? `${raw.streak}-day streak` : "no active streak"}</div>;
  }
  return null;
}

function widgetRuntimeStatus(id: string, live: { loading?: boolean; error?: boolean; stale?: boolean; updatedAt?: string } | undefined, catalogLive?: boolean): WidgetStatus {
  const definition = getWidgetDefinition(id);
  if (live?.loading && live.updatedAt) return "refreshing";
  if (live?.loading) return "loading";
  if (live?.error && live.stale) return "stale";
  if (live?.error) return "error";
  if (live?.stale) return "stale";
  if (live?.updatedAt) return "fresh";
  if (definition?.statusDefault) return definition.statusDefault;
  return catalogLive === false ? "lab" : "setup_required";
}

/* ── art gallery card ──────────────────────────────────────────── */

type Artwork = {
  id: number;
  title: string;
  artist: string;
  date: string;
  medium: string;
  origin: string;
  imageUrl: string;
  artUrl: string;
};

function ArtGalleryCard() {
  const [seed, setSeed] = useState(Math.floor(Date.now() / 86400000));
  const [art, setArt] = useState<Artwork | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    setFetching(true);
    setImgLoaded(false);
    fetch(`/api/widgets/art?seed=${seed}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Artwork | null) => { setArt(d); setFetching(false); })
      .catch(() => setFetching(false));
  }, [seed]);

  return (
    <Card>
      <h2 className="sec">
        Art of the Day<span className="rule" />
        <span className="count" style={{ cursor: "pointer" }} onClick={() => setSeed((s) => s + 1)} title="Next artwork">Next →</span>
      </h2>
      <div className="art-card">
        {fetching ? (
          <div className="art-loading">Sourcing from the collection…</div>
        ) : art ? (
          <>
            <a href={art.artUrl} target="_blank" rel="noopener noreferrer" className="art-img-wrap">
              <Image
                src={art.imageUrl}
                alt={art.title}
                fill
                sizes="(max-width: 900px) 100vw, 25vw"
                unoptimized
                className={`art-img${imgLoaded ? " loaded" : ""}`}
                onLoad={() => setImgLoaded(true)}
              />
              <div className="art-overlay" />
            </a>
            <div className="art-meta">
              <div className="art-title">{art.title}</div>
              <div className="art-artist">
                {art.artist}
                {art.date ? <span className="art-date"> · {art.date}</span> : null}
              </div>
              {art.medium && <div className="art-medium">{art.medium}</div>}
              <div className="art-credit">Art Institute of Chicago</div>
            </div>
          </>
        ) : (
          <div className="art-loading">Artwork unavailable</div>
        )}
      </div>
    </Card>
  );
}

/* ── daily reflections ─────────────────────────────────────────── */

const DAILY_REFLECTIONS = [
  { text: "The unexamined life is not worth living.", author: "Socrates", source: "Apology" },
  { text: "Man is condemned to be free.", author: "Jean-Paul Sartre", source: "Existentialism is a Humanism" },
  { text: "To know what you know and what you do not know — that is true knowledge.", author: "Confucius", source: "Analects" },
  { text: "The obstacle is the way.", author: "Marcus Aurelius", source: "Meditations" },
  { text: "Life must be understood backwards, but it must be lived forwards.", author: "Søren Kierkegaard" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Aristotle" },
  { text: "He who has a why to live can bear almost any how.", author: "Friedrich Nietzsche", source: "Twilight of the Idols" },
  { text: "Cogito, ergo sum.", author: "René Descartes", source: "Discourse on the Method" },
  { text: "The limits of my language mean the limits of my world.", author: "Ludwig Wittgenstein", source: "Tractatus" },
  { text: "One cannot step into the same river twice.", author: "Heraclitus" },
  { text: "The cave you fear to enter holds the treasure you seek.", author: "Joseph Campbell", source: "The Hero with a Thousand Faces" },
  { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
  { text: "Beauty will save the world.", author: "Fyodor Dostoevsky", source: "The Idiot" },
  { text: "The journey of a thousand miles begins with one step.", author: "Lao Tzu", source: "Tao Te Ching" },
  { text: "The soul becomes dyed with the colour of its thoughts.", author: "Marcus Aurelius", source: "Meditations" },
  { text: "Time you enjoy wasting is not wasted time.", author: "Bertrand Russell" },
  { text: "All that we see or seem is but a dream within a dream.", author: "Edgar Allan Poe" },
  { text: "Knowing yourself is the beginning of all wisdom.", author: "Aristotle" },
  { text: "Not all who wander are lost.", author: "J.R.R. Tolkien", source: "The Fellowship of the Ring" },
  { text: "The present moment always will have been.", author: "Marcus Aurelius", source: "Meditations" },
  { text: "To do great work, one must know how to wait.", author: "Leo Tolstoy" },
  { text: "Between stimulus and response there is a space. In that space is our power to choose.", author: "Viktor Frankl", source: "Man's Search for Meaning" },
  { text: "The hardest thing in the world is to simplify your life. It's so easy to make it complex.", author: "Yvon Chouinard" },
  { text: "In the depth of winter I finally learned that there was in me an invincible summer.", author: "Albert Camus" },
  { text: "Do not pray for an easy life; pray for the strength to endure a difficult one.", author: "Bruce Lee" },
  { text: "What is not started today is never finished tomorrow.", author: "Johann Wolfgang von Goethe" },
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Excellence is never an accident.", author: "Aristotle" },
] as const;

/* ── constants ─────────────────────────────────────────────────── */

const CONSOLE_SECTION_ORDER_KEY = "axis-console-sections";
const DEFAULT_SECTION_ORDER = [
  "widgets",
  "photos",
  "dispatch-block",
  "pomodoro",
  "routine",
  "daily-rings",
  "todays-arc",
  "focus-ranked",
  "people-spotlight",
  "weekly-devotional",
  "stoic-maxim",
  "markets-body",
  "art-gallery",
] as const;

type SectionId = (typeof DEFAULT_SECTION_ORDER)[number];

const CONSOLE_BLOCK_SIZES_KEY = "axis-console-block-sizes";
// Defaults lean on "md" (half-width) for the content cards so blocks sit
// side-by-side out of the box — that's what makes "drag a widget to the right"
// possible. The full-bleed sections (the tidbits bar + featured photos) stay
// "full"; pomodoro stays compact. Any block can still be resized sm/md/full.
const DEFAULT_BLOCK_SIZES: Record<SectionId, BlockSize> = {
  "widgets": "full", "photos": "full", "dispatch-block": "md",
  "pomodoro": "sm", "routine": "md", "daily-rings": "md",
  "todays-arc": "md", "focus-ranked": "md", "people-spotlight": "md",
  "weekly-devotional": "md", "stoic-maxim": "md", "markets-body": "md",
  "art-gallery": "md",
};

// Three-step granular sizing: sm (1 col) → md (2 col) → full (all 4 cols) → sm…
const NEXT_BLOCK_SIZE: Record<BlockSize, BlockSize> = { sm: "md", md: "full", full: "sm" };
const BLOCK_SIZE_GLYPH: Record<BlockSize, string> = { sm: "⊞", md: "⊡", full: "⊟" };
const BLOCK_SIZE_LABEL: Record<BlockSize, string> = { sm: "Compact", md: "Medium", full: "Full width" };

type BlockSizeCtx = { sizes: Record<string, BlockSize>; toggle: (id: string) => void };
const BlockSizeContext = createContext<BlockSizeCtx>({ sizes: {}, toggle: () => {} });

/* ── HeroLine ──────────────────────────────────────────────────── */

function HeroLine({ tasks }: { tasks: Task[] }) {
  const open = tasks.filter((t) => t.status !== "done");
  const today = new Date();
  const dueToday = open.filter(
    (t) => t.deadline && new Date(t.deadline).toDateString() === today.toDateString(),
  );
  const overdue = open.filter((t) => t.status === "overdue");

  if (open.length === 0) {
    return (
      <h1 className="hero-title">
        A clear slate — <em>capture a thought below</em>
        <br />
        and let the console file it.
      </h1>
    );
  }

  return (
    <h1 className="hero-title">
      {open.length} open {open.length === 1 ? "task" : "tasks"},{" "}
      <em>
        {overdue.length > 0
          ? `${overdue.length} overdue`
          : dueToday.length > 0
            ? `${dueToday.length} due today`
            : "nothing overdue"}
      </em>
      ,<br />
      and the morning block is yours.
    </h1>
  );
}

/* ── DraggableBlock ────────────────────────────────────────────── */

// Structured grid snapping on a 4-col base grid: "sm" cards occupy one column,
// "md" cards span two, "full" cards span the entire row — so the packing
// stays clean with no overlaps while giving more granular size steps than a
// binary sm/full toggle.
const BLOCK_SPAN: Record<BlockSize, string> = { sm: "span 1", md: "span 2", full: "1 / -1" };

function DraggableBlock({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const { sizes, toggle } = useContext(BlockSizeContext);
  const size = sizes[id] ?? "full";
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      ref={setNodeRef}
      className={`block-wrap${size !== "full" ? ` block-${size}` : ""}`}
      layout={!reduceMotion && !isDragging ? "position" : false}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        // While dragging, lift the card above its neighbors so the snap target
        // reads clearly during the freeform rearrange.
        zIndex: isDragging ? 2 : 1,
        position: "relative",
        gridColumn: BLOCK_SPAN[size],
        minWidth: 0,
      }}
    >
      <div className="block-controls">
        <button
          type="button"
          onClick={() => toggle(id)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-faint)", fontSize: 13, lineHeight: 1, padding: "2px 3px", borderRadius: "var(--r)" }}
          title={`${BLOCK_SIZE_LABEL[size]} — click to resize`}
        >
          {BLOCK_SIZE_GLYPH[size]}
        </button>
        <div
          {...attributes}
          {...listeners}
          className="block-drag-handle"
          title="Drag anywhere on this handle to move the block"
        >
          <span className="block-drag-grip">⠿</span>
        </div>
      </div>
      {children}
    </motion.div>
  );
}

/* ── ConsoleModule ─────────────────────────────────────────────── */

export function ConsoleModule() {
  const supabase = useMemo(() => createClient(), []);
  const { toast } = useToast();
  const { interfaceSettings } = useTheme();
  const { signals, capture, applyClassification } = useSignals();
  const { tasks, toggleDone, addTask } = useTasks();
  const { createNote } = useNotes();
  const [widgetIds, setWidgetIds] = useState<string[]>(DEFAULT_WIDGET_IDS);
  const [widgetTexts, setWidgetTexts] = useState<Record<string, { v: string; k: string }>>({});
  const [arcEvents, setArcEvents] = useState<Array<{ id: string; title: string; start_at: string; end_at: string | null }>>([]);
  const [editing, setEditing] = useState(false);
  const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
  const [detailWidgetId, setDetailWidgetId] = useState<string | null>(null);
  const [swapIdx, setSwapIdx] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [captureText, setCaptureText] = useState("");
  const [captMode, setCaptMode] = useState<"task" | "note" | "paper" | null>(null);
  const [dispatchExpanded, setDispatchExpanded] = useState(false);
  const [triagingIds, setTriagingIds] = useState<Set<string>>(new Set());
  const pomModeRef = useRef<"work" | "break">("work");
  const [pomMode, setPomMode] = useState<"work" | "break">("work");
  const [pomSec, setPomSec] = useState(25 * 60);
  const [pomRunning, setPomRunning] = useState(false);
  const [pomBlocks, setPomBlocks] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    try { return Number(localStorage.getItem(`axis-pom-${new Date().toDateString()}`) ?? "0"); } catch { return 0; }
  });
  const { data: liveData, refreshOne, refreshAll, geoStatus } = useWidgetData(widgetIds, interfaceSettings.locationServices);

  // Location Services is opt-in (Interface Studio); if the browser denies the
  // permission prompt (or geolocation isn't available at all) the widgets
  // silently fall back to the default location — surface that once instead
  // of leaving the user wondering why "On" never seems to do anything.
  const geoNoticeShown = useRef(false);
  useEffect(() => {
    if (geoNoticeShown.current) return;
    if (geoStatus === "denied") {
      geoNoticeShown.current = true;
      toast("Location permission denied — showing weather for the default location instead.", "warn", "Location");
    } else if (geoStatus === "unavailable") {
      geoNoticeShown.current = true;
      toast("Location isn't available on this device/browser — showing the default location.", "warn", "Location");
    }
  }, [geoStatus, toast]);

  // Section ordering + block size state
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>([...DEFAULT_SECTION_ORDER]);
  const [blockSizes, setBlockSizes] = useState<Record<SectionId, BlockSize>>({ ...DEFAULT_BLOCK_SIZES });
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Layout auto-save plumbing. `layoutColumnRef` flips to false the first time a
  // write reveals the `layout` column isn't applied yet — after that we persist
  // to localStorage only so the UX never blocks on an unmigrated DB.
  const layoutColumnRef = useRef(true);
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const topTasks = useMemo(() => rankTasks(tasks).slice(0, 3), [tasks]);
  const { people } = usePeople();
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());

  const unread = useMemo(() => signals.filter((s) => !s.read_at && isSignalVisible(s)).length, [signals]);
  const actionable = useMemo(
    () => signals.filter((s) => isSignalActionable(s)),
    [signals],
  );
  const duePeople = useMemo(() => {
    const nowMs = Date.now();
    return people
      .filter((p) => p.follow_up_on && new Date(`${p.follow_up_on}T23:59:59`) <= new Date(nowMs + 3 * 86400000))
      .sort((a, b) => (a.follow_up_on ?? "").localeCompare(b.follow_up_on ?? ""))
      .slice(0, 4);
  }, [people]);

  // Load section order + block sizes from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONSOLE_SECTION_ORDER_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as SectionId[];
        const allPresent = DEFAULT_SECTION_ORDER.every((id) => parsed.includes(id));
        if (allPresent && parsed.length === DEFAULT_SECTION_ORDER.length) setSectionOrder(parsed);
      }
      const storedSizes = localStorage.getItem(CONSOLE_BLOCK_SIZES_KEY);
      if (storedSizes) {
        const parsedSizes = JSON.parse(storedSizes) as Record<string, BlockSize>;
        const valid: Partial<Record<SectionId, BlockSize>> = {};
        for (const [id, size] of Object.entries(parsedSizes)) {
          if ((BLOCK_SIZES as string[]).includes(size)) valid[id as SectionId] = size;
        }
        setBlockSizes((prev) => ({ ...prev, ...valid }));
      }
    } catch { /* ignore */ }
  }, []);

  // Debounced auto-save of the freeform layout (order + per-block sizes).
  // Always mirrors to localStorage; additionally persists to the `layout` jsonb
  // column when it exists. If the column isn't applied yet, the first write
  // detects the schema error, flips layoutColumnRef off, and we degrade to
  // localStorage-only — the drag/snap UX is unaffected either way.
  const persistLayout = useCallback(
    (order: SectionId[], sizes: Record<SectionId, BlockSize>) => {
      try { localStorage.setItem(CONSOLE_SECTION_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
      try { localStorage.setItem(CONSOLE_BLOCK_SIZES_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }

      if (!layoutColumnRef.current) return;
      if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
      layoutSaveTimer.current = setTimeout(async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { error } = await supabase.from("console_widgets").upsert(
          {
            user_id: user.id,
            layout: { order, sizes },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
        // 42703 = undefined_column, PGRST204 = column not in PostgREST schema cache.
        if (error && (error.code === "42703" || error.code === "PGRST204" || /layout/i.test(error.message))) {
          layoutColumnRef.current = false;
        }
      }, 600);
    },
    [supabase],
  );

  useEffect(() => () => { if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current); }, []);

  const toggleBlockSize = useCallback((id: string) => {
    setBlockSizes((prev) => {
      const current = prev[id as SectionId] ?? "full";
      const next = { ...prev, [id]: NEXT_BLOCK_SIZE[current] } as Record<SectionId, BlockSize>;
      persistLayout(sectionOrder, next);
      return next;
    });
  }, [persistLayout, sectionOrder]);

  const resetLayout = useCallback(() => {
    const order: SectionId[] = [...DEFAULT_SECTION_ORDER];
    const sizes: Record<SectionId, BlockSize> = { ...DEFAULT_BLOCK_SIZES };
    setSectionOrder(order);
    setBlockSizes(sizes);
    persistLayout(order, sizes);
    toast("Layout reset to default.", "success", "Console");
  }, [persistLayout, toast]);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("console_widgets")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) toast(error.message, "error", "Console");
    else if (data) {
      setWidgetIds(data.widget_ids?.length ? data.widget_ids : DEFAULT_WIDGET_IDS);
      setWidgetTexts((data.widget_texts as Record<string, { v: string; k: string }>) || {});

      // Freeform layout (order + per-block sizes). `layout` may be absent if the
      // migration hasn't been applied yet — guard the read so we silently fall
      // back to the localStorage/default order set by the mount effect.
      const layout = normalizeConsoleLayout(
        (data as { layout?: unknown }).layout,
        DEFAULT_SECTION_ORDER,
      );
      if (layout) {
        setSectionOrder(layout.order as SectionId[]);
        setBlockSizes((prev) => ({ ...prev, ...(layout.sizes as Record<SectionId, BlockSize>) }));
      }
    }

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const { data: events } = await supabase
      .from("schedule_events")
      .select("id, title, start_at, end_at")
      .eq("user_id", user.id)
      .gte("start_at", todayStart.toISOString())
      .lte("start_at", todayEnd.toISOString())
      .order("start_at", { ascending: true });
    if (events) setArcEvents(events);

    setLoading(false);
  }, [supabase, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (ids: string[], texts: Record<string, { v: string; k: string }>) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from("console_widgets").upsert(
      {
        user_id: user.id,
        widget_ids: ids,
        sort_order: ids,
        widget_texts: texts,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) toast(error.message, "error", "Console");
    else toast("Widget layout saved.", "success", "Console");
  };

  const handleCapture = async () => {
    if (!captureText.trim()) return;
    const text = captureText.trim();
    setCaptureText("");

    // Always create a signal in the inbox
    await capture(text);

    // Call AI for classification
    fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "capture", text }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then(async (d: { label: string; action: string; priority: "hi" | "med" | "lo" } | null) => {
        const priority = d?.priority ?? "med";

        // Save to tasks table if captMode is "task"
        if (captMode === "task") {
          await addTask({ title: text, category: "personal", priority });
          toast(d?.label ? `Task · ${d.label} · ${d.action}` : "Task saved", "success", "Capture");
          return;
        }

        // Save to notes table if captMode is "note"
        if (captMode === "note") {
          await createNote(text, "Inbox");
          toast(d?.label ? `Note · ${d.label}` : "Note saved", "success", "Capture");
          return;
        }

        // Default: show AI classification toast
        if (d?.label && d?.action) {
          toast(`${d.label} · ${d.action}`, "info", "AI");
        } else {
          toast("Captured to Signals inbox", "success", "Console");
        }
      })
      .catch(() => toast("Captured to Signals inbox", "success", "Console"));
  };

  const handleTriage = async (s: { id: string; title: string; body: string | null; source: string }) => {
    setTriagingIds((prev) => new Set(prev).add(s.id));
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "triage", text: s.title, body: s.body ?? "" }),
      });
      if (res.ok) {
        const d = await res.json() as { title: string; priority: "hi" | "med" | "lo"; category: string; effort: string };
        await applyClassification(s.id, {
          signal_type: "action",
          priority: d.priority,
          destination: d.category,
          reason: `${d.category} · ${d.effort}`,
          confidence: 0.8,
        });
        toast(`Triaged · ${d.priority.toUpperCase()} · ${d.category} · ${d.effort}`, "info", "AI");
      }
    } catch {
      toast("Triage failed — check connection", "error", "AI");
    } finally {
      setTriagingIds((prev) => { const n = new Set(prev); n.delete(s.id); return n; });
    }
  };

  useEffect(() => { pomModeRef.current = pomMode; }, [pomMode]);

  useEffect(() => {
    if (!pomRunning) return;
    const pomDate = new Date().toDateString();
    const id = setInterval(() => {
      setPomSec((s) => {
        if (s > 1) return s - 1;
        const mode = pomModeRef.current;
        const nextMode: "work" | "break" = mode === "work" ? "break" : "work";
        const nextSec = nextMode === "work" ? 25 * 60 : 5 * 60;
        setTimeout(() => {
          setPomRunning(false);
          setPomMode(nextMode);
          setPomSec(nextSec);
          if (mode === "work") {
            setPomBlocks((b) => {
              const n = b + 1;
              try { localStorage.setItem(`axis-pom-${pomDate}`, String(n)); } catch {}
              return n;
            });
          }
          const msg = mode === "work"
            ? "Focus block complete — take a 5-minute break."
            : "Break over — start the next focus block.";
          toast(msg, "success", "Pomodoro");
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification("Axis · Pomodoro", { body: msg });
          }
        }, 0);
        return 0;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [pomRunning, toast]);

  // dnd-kit sensors. Activation distance lowered from 8px → 3px so drags
  // start responsively now that pointer events are scoped to the (larger)
  // drag handle — the handle no longer needs a long pull before it "takes".
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setSectionOrder((prev) => {
      const oldIndex = prev.indexOf(active.id as SectionId);
      const newIndex = prev.indexOf(over.id as SectionId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      // Auto-save on drag-end (debounced) — no manual "save" step for layout.
      persistLayout(next, blockSizes);
      return next;
    });
  };

  if (loading) return <div className="empty-state">Loading console…</div>;

  // ── section render map ──────────────────────────────────────────

  const widgetsSection = (
    <DraggableBlock key="widgets" id="widgets">
      <div style={{ paddingTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginBottom: "var(--space-2)" }}>
          <button type="button" className="feed-manage" onClick={() => { refreshAll(); }}>Refresh</button>
          <button
            type="button"
            className="feed-manage"
            onClick={() => {
              if (editing) save(widgetIds, widgetTexts);
              setEditing((e) => !e);
            }}
          >
            {editing ? "Done" : "Customize"}
          </button>
        </div>
        <div className="tidbits">
          {widgetIds.map((id, i) => {
            const w = getWidgetById(id);
            const definition = getWidgetDefinition(id);
            const live = liveData[id];
            const texts = widgetTexts[id];
            const value = editing ? (texts?.v ?? live?.v ?? w.value) : (live?.v ?? texts?.v ?? w.value);
            const hint = editing ? (texts?.k ?? live?.k ?? w.hint) : (live?.k ?? texts?.k ?? w.hint);
            const status = widgetRuntimeStatus(id, live, w.live);
            const shellIcon = definition?.icon ?? <WidgetIcon id={id} />;
            if (id === "weather") {
              const drawerOpen = detailWidgetId === id;
              return (
                <Fragment key={`${id}-${i}`}>
                  <WidgetShell
                    title={definition?.label ?? w.label}
                    icon={shellIcon}
                    value={value}
                    hint={drawerOpen ? `${hint} · details open` : hint}
                    status={status}
                    updatedAt={live?.updatedAt}
                    provider={definition?.source.provider ?? "widget"}
                    loading={live?.loading}
                    stale={live?.stale}
                    error={live?.error}
                    lab={status === "lab"}
                    disconnected={status === "disconnected"}
                    onPrimaryAction={editing ? undefined : () => setDetailWidgetId(id)}
                    titleText={drawerOpen ? "Details open" : "Open widget details"}
                    actionSlot={
                      <WidgetActionMenu
                        actions={editing ? [
                          { id: "swap", label: "Swap", kind: "configure" },
                          { id: "hide", label: "Hide placeholder", kind: "hide", disabledReason: "Hide arrives with saved widget preferences." },
                        ] : [
                          ...(definition?.secondaryActions ?? []),
                          definition?.primaryAction ?? { id: "open", label: "Open", kind: "open-drawer" },
                          { id: "configure", label: "Configure placeholder", kind: "configure", disabledReason: "Configuration arrives with widget settings." },
                          { id: "hide", label: "Hide placeholder", kind: "hide", disabledReason: "Hide arrives with saved widget preferences." },
                        ]}
                        handlers={{
                          refresh: () => {
                            refreshOne(id);
                            toast("Widget refreshed", "success", w.label);
                          },
                          open: () => setDetailWidgetId(id),
                          configure: () => {
                            if (editing) {
                              setSwapIdx(i);
                              setPickerOpen(true);
                            }
                          },
                        }}
                      />
                    }
                  >
                    {!editing && live?.error && (
                      <div className="tb-raw" style={{ color: "var(--clay)" }}>
                        {live.stale ? "Showing last update" : "Refresh failed"}
                      </div>
                    )}
                  </WidgetShell>
                  <WidgetDetailDrawer
                    open={drawerOpen}
                    onClose={() => setDetailWidgetId(null)}
                    title={definition?.detail.title ?? definition?.label ?? w.label}
                    subtitle={hint}
                    status={status}
                    source={definition?.source.provider ?? "widget"}
                    updatedAt={live?.updatedAt}
                    primaryActionSlot={
                      <button
                        type="button"
                        className="feed-manage"
                        onClick={() => {
                          refreshOne(id);
                          toast("Widget refreshed", "success", w.label);
                        }}
                      >
                        Refresh
                      </button>
                    }
                  >
                    <div className="widget-detail-current">
                      <span>Current value</span>
                      <strong>{value}</strong>
                    </div>
                    {live?.error ? (
                      <div className="widget-detail-error">
                        {live.stale ? "The drawer is showing the last known widget state." : "The latest widget refresh failed."}
                      </div>
                    ) : null}
                  </WidgetDetailDrawer>
                </Fragment>
              );
            }
            const statusLabel = status === "fresh" ? "Fresh" : status === "loading" || status === "refreshing" ? "Refreshing" : status === "stale" ? "Stale" : status === "error" ? "Error" : status === "lab" ? "Lab" : status === "disconnected" ? "Disconnected" : status === "empty" ? "Empty" : "Setup";
            return (
              <div
                key={`${id}-${i}`}
                className="tb"
                style={{ position: "relative", cursor: editing ? "default" : "pointer" }}
                onClick={() => !editing && setExpandedWidget(expandedWidget === id ? null : id)}
                title={expandedWidget === id ? "Click to collapse" : "Click to expand · double-click refreshes"}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  refreshOne(id);
                  toast("Widget refreshed", "success", w.label);
                }}
              >
                {editing && (
                  <button
                    type="button"
                    style={{ position: "absolute", right: 8, top: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent-2)" }}
                    onClick={(e) => { e.stopPropagation(); setSwapIdx(i); setPickerOpen(true); }}
                  >
                    ⇄
                  </button>
                )}
                <div className="tb-ic" style={widgetIconStyle(id, live?.raw)}><WidgetIcon id={id} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="tb-v" contentEditable={editing} suppressContentEditableWarning onBlur={(e) => {
                    const next = { ...widgetTexts, [id]: { v: e.currentTarget.textContent || value, k: hint } };
                    setWidgetTexts(next);
                  }}>{value} {!editing && <span style={{ color: "var(--ink-faint)", fontSize: 10 }}>· {statusLabel}</span>}</div>
                  <div className="tb-k" contentEditable={editing} suppressContentEditableWarning onBlur={(e) => {
                    const next = { ...widgetTexts, [id]: { v: value, k: e.currentTarget.textContent || hint } };
                    setWidgetTexts(next);
                  }}>{expandedWidget === id ? `${hint} · tap to collapse` : hint}</div>
                  {expandedWidget === id && !editing && <WidgetSecondLine id={id} raw={live?.raw} />}
                  {!editing && live?.loading && live.updatedAt && (
                    <div className="tb-raw">Refreshing…</div>
                  )}
                  {!editing && live?.error && (
                    <div className="tb-raw" style={{ color: "var(--clay)" }}>
                      {live.stale ? "Showing last update" : "Refresh failed"}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </DraggableBlock>
  );

  const photosSection = (
    <DraggableBlock key="photos" id="photos">
      <FeaturedPhotos />
    </DraggableBlock>
  );

  const tasksDone  = tasks.filter((t) => t.status === "done").length;
  const tasksTotal = Math.max(tasks.length, 8);
  const tasksPct   = Math.min(tasksDone / tasksTotal, 1);
  // r3 circumference = 2π × 28 ≈ 175.9
  const r3Offset   = Math.round(175.9 * (1 - tasksPct));
  const overallPct = Math.round(tasksPct * 100);

  const dailyRingsSection = (
    <DraggableBlock key="daily-rings" id="daily-rings">
      <Card tick>
        <h2 className="sec">Daily Rings<span className="rule" /><span className="count">{overallPct}%</span></h2>
        <div className="rings-wrap">
          <svg className="rings" viewBox="0 0 120 120">
            <circle className="rbg" cx="60" cy="60" r="52" /><circle className="rfg r1" cx="60" cy="60" r="52" style={{ strokeDashoffset: 326.7 }} />
            <circle className="rbg" cx="60" cy="60" r="40" /><circle className="rfg r2" cx="60" cy="60" r="40" style={{ strokeDashoffset: 251.3 }} />
            <circle className="rbg" cx="60" cy="60" r="28" /><circle className="rfg r3" cx="60" cy="60" r="28" style={{ strokeDashoffset: r3Offset }} />
          </svg>
          <div className="rings-legend">
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--accent)" }} /><span className="rl-name">Deep work</span><span className="rl-v">Lab</span></div>
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--up)" }} /><span className="rl-name">Movement</span><span className="rl-v">Connect Strava</span></div>
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--marine)" }} /><span className="rl-name">Tasks</span><span className="rl-v">{tasksDone} / {tasksTotal}</span></div>
          </div>
        </div>
      </Card>
    </DraggableBlock>
  );

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const todaysArcSection = (
    <DraggableBlock key="todays-arc" id="todays-arc">
      <Card tick>
        <h2 className="sec">Today&apos;s Arc<span className="rule" /><span className="count">{arcEvents.length || "Schedule"}</span></h2>
        {arcEvents.length === 0 ? (
          <p style={{ marginTop: 12, color: "var(--ink-faint)", fontSize: 12 }}>No events scheduled for today. Add events on the Schedule page.</p>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {arcEvents.map((ev) => (
              <div key={ev.id} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--ink-dim)", flexShrink: 0 }}>{fmtTime(ev.start_at)}</span>
                <span style={{ fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.title}</span>
                {ev.end_at && <span style={{ fontSize: 11, color: "var(--ink-faint)", flexShrink: 0 }}>→ {fmtTime(ev.end_at)}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </DraggableBlock>
  );

  const focusRankedSection = (
    <DraggableBlock key="focus-ranked" id="focus-ranked">
      <Card>
        <h2 className="sec">Focus · Ranked<span className="rule" /><span className="count">Top {topTasks.length || 3}</span></h2>
        <div style={{ marginTop: 14 }}>
          {topTasks.length === 0 ? (
            <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>Add tasks in Agenda to populate ranked focus.</p>
          ) : (
            topTasks.map((t) => (
              <div key={t.id} className={`task${t.status === "done" ? " done" : ""}`}>
                <div className={`check${t.status === "done" ? " done" : ""}`} onClick={() => toggleDone(t.id)} />
                <div className="task-main">
                  <div className="task-title">{t.title}</div>
                  <div className="task-meta">
                    <span className={`pill ${t.priority}`}>{t.priority.toUpperCase()}</span>
                    {t.effort && <span>{t.effort}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </DraggableBlock>
  );

  const weeklyDevotionalSection = (
    <DraggableBlock key="weekly-devotional" id="weekly-devotional">
      <Card tick className="devo">
        <div className="eyebrow" style={{ color: "var(--clay)" }}>Weekly Devotional · Day 4/7</div>
        <div className="verse">&ldquo;Whatever you do, work heartily, as for the Lord and not for men.&rdquo;</div>
        <div className="ref">COLOSSIANS 3:23 · ESV</div>
      </Card>
    </DraggableBlock>
  );

  const todayQuote = DAILY_REFLECTIONS[Math.floor(Date.now() / 86400000) % DAILY_REFLECTIONS.length];

  const stoicMaximSection = (
    <DraggableBlock key="stoic-maxim" id="stoic-maxim">
      <Card tick className="quote-card">
        <div className="eyebrow" style={{ color: "var(--accent-2)" }}>Daily Reflection</div>
        <div className="qtext">&ldquo;{todayQuote.text}&rdquo;</div>
        <div className="qauth">
          — {todayQuote.author}
          {"source" in todayQuote && todayQuote.source ? <>, <em>{todayQuote.source}</em></> : null}
        </div>
      </Card>
    </DraggableBlock>
  );

  const artGallerySection = (
    <DraggableBlock key="art-gallery" id="art-gallery">
      <ArtGalleryCard />
    </DraggableBlock>
  );

  const marketsBodySection = (
    <DraggableBlock key="markets-body" id="markets-body">
      <Card>
        <h2 className="sec">
          Markets &amp; Body<span className="rule" />
          <span className="count">
            {liveData.markets?.error ? "Stale" : liveData.markets ? "Live" : "Cached"}
          </span>
        </h2>
        <div style={{ marginTop: 12 }}>
          <div className="metricrow"><span className="metric-k">Markets</span><span className="metric-v">{liveData.markets?.v ?? "—"}</span></div>
          {liveData.markets?.k && (
            <div className="metricrow"><span className="metric-k">Hint</span><span className="metric-v" style={{ fontSize: 11 }}>{liveData.markets.k}</span></div>
          )}
        </div>
      </Card>
    </DraggableBlock>
  );

  // ── Dispatch block ──────────────────────────────────────────────
  const dispatchBlockSection = (
    <DraggableBlock key="dispatch-block" id="dispatch-block">
      <Card>
        <h2 className="sec">
          Dispatch
          <span className="rule" />
          <span className="count" style={{ color: unread > 0 ? "var(--clay)" : "var(--up)" }}>
            {unread > 0 ? `${unread} unread` : "Clear"}
          </span>
          {actionable.length > 3 && (
            <button
              type="button"
              onClick={() => setDispatchExpanded((e) => !e)}
              style={{ marginLeft: "auto", fontSize: 9, fontFamily: "var(--mono)", color: "var(--ink-faint)", background: "none", border: "none", cursor: "pointer", padding: "0 4px", letterSpacing: ".06em" }}
            >
              {dispatchExpanded ? "▲ collapse" : "▾ expand"}
            </button>
          )}
        </h2>
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {actionable.length === 0 ? (
            <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>No action items — inbox clear.</p>
          ) : (
            (dispatchExpanded ? actionable : actionable.slice(0, 3)).map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", background: "var(--glass)", borderRadius: "var(--r)", border: "1px solid var(--line)" }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.metadata?.ai_priority === "hi" ? "var(--clay)" : s.metadata?.ai_priority === "lo" ? "var(--ink-faint)" : "var(--clay)", flexShrink: 0, marginTop: 5 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, color: "var(--ink)" }}>{s.title}</div>
                  {s.body && (
                    <div style={{ fontSize: 11, color: "var(--ink-dim)", marginTop: 2 }}>
                      {dispatchExpanded ? s.body : `${s.body.slice(0, 80)}${s.body.length > 80 ? "…" : ""}`}
                    </div>
                  )}
                  {s.metadata?.ai_reason && (
                    <div style={{ fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--accent-2)", marginTop: 3 }}>
                      AI: {s.metadata.ai_reason as string}
                    </div>
                  )}
                  {dispatchExpanded && s.source && (
                    <div style={{ fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--ink-faint)", marginTop: 4 }}>
                      Source: {s.source}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--ink-faint)", marginTop: 1 }}>{s.source}</span>
                  {!s.metadata?.ai_at && (
                    <button
                      type="button"
                      onClick={() => handleTriage(s)}
                      disabled={triagingIds.has(s.id)}
                      style={{
                        fontSize: 8.5, fontFamily: "var(--mono)", letterSpacing: ".06em",
                        color: triagingIds.has(s.id) ? "var(--ink-faint)" : "var(--accent-2)",
                        background: "none", border: "1px solid var(--line)", borderRadius: 2,
                        padding: "1px 5px", cursor: triagingIds.has(s.id) ? "default" : "pointer",
                        transition: "color 0.14s, border-color 0.14s",
                      }}
                    >
                      {triagingIds.has(s.id) ? "…" : "TRIAGE"}
                    </button>
                  )}
                  {s.metadata?.ai_priority && (
                    <span style={{ fontSize: 8, fontFamily: "var(--mono)", color: s.metadata.ai_priority === "hi" ? "var(--clay)" : s.metadata.ai_priority === "lo" ? "var(--ink-faint)" : "var(--gold-2)", letterSpacing: ".08em" }}>
                      {(s.metadata.ai_priority as string).toUpperCase()}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
          {!dispatchExpanded && actionable.length > 3 && (
            <button
              type="button"
              onClick={() => setDispatchExpanded(true)}
              style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0 }}
            >
              +{actionable.length - 3} more — tap to expand
            </button>
          )}
        </div>
      </Card>
    </DraggableBlock>
  );

  // ── Time-aware routine ──────────────────────────────────────────
  const hour = new Date().getHours();
  const isMorning = hour >= 5 && hour < 12;
  const isEvening = hour >= 18;
  const routineLabel = isMorning ? "Morning Routine" : isEvening ? "Evening Wind-Down" : "Midday Check";
  const routineColor = isMorning ? "var(--gold)" : isEvening ? "var(--marine-2)" : "var(--up)";
  const routineItems: string[] = isMorning
    ? ["Hydrate before coffee", "Review today's top 3 tasks", "10-min mindfulness", "Check Dispatch inbox", "Block focus time on calendar"]
    : isEvening
    ? ["Review what got done", "Prepare top 3 tasks for tomorrow", "Clear Dispatch inbox", "Log open loops", "Screens off by 10 pm"]
    : ["Midday check: on track?", "Hydrate and move 5 min", "Clear any blocking decisions"];
  const toggleRoutineItem = (key: string) =>
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const routineSection = (
    <DraggableBlock key="routine" id="routine">
      <Card>
        <h2 className="sec">
          {routineLabel}
          <span className="rule" />
          <span className="count" style={{ color: routineColor }}>
            {checkedItems.size}/{routineItems.length}
          </span>
        </h2>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
          {routineItems.map((item) => {
            const done = checkedItems.has(item);
            return (
              <button
                key={item}
                type="button"
                onClick={() => toggleRoutineItem(item)}
                style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
              >
                <span style={{ width: 16, height: 16, flexShrink: 0, borderRadius: 3, border: `1.5px solid ${done ? routineColor : "var(--line-strong)"}`, background: done ? routineColor : "transparent", display: "flex", alignItems: "center", justifyContent: "center", transition: "0.14s" }}>
                  {done && <svg viewBox="0 0 10 10" fill="none" stroke="#0a0b0e" strokeWidth="2" style={{ width: 7, height: 7 }}><polyline points="1.5,5 4,7.5 8.5,2.5" /></svg>}
                </span>
                <span style={{ fontSize: 12, color: done ? "var(--ink-faint)" : "var(--ink-dim)", textDecoration: done ? "line-through" : "none", transition: "0.14s" }}>{item}</span>
              </button>
            );
          })}
        </div>
      </Card>
    </DraggableBlock>
  );

  // ── People CRM spotlight ────────────────────────────────────────
  const now = new Date();
  const tagColor: Record<string, string> = { mentor: "var(--marine-2)", collaborator: "var(--up)", friend: "var(--gold-2)" };

  const peopleSpotlightSection = (
    <DraggableBlock key="people-spotlight" id="people-spotlight">
      <Card>
        <h2 className="sec">
          People · Follow-Up
          <span className="rule" />
          <span className="count" style={{ color: duePeople.length > 0 ? "var(--clay)" : "var(--up)" }}>
            {duePeople.length > 0 ? `${duePeople.length} due` : "All good"}
          </span>
        </h2>
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          {duePeople.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>No upcoming follow-ups — add people in the CRM.</p>
          ) : (
            duePeople.map((p) => {
              const daysLeft = p.follow_up_on
                ? Math.round((new Date(`${p.follow_up_on}T23:59:59`).getTime() - now.getTime()) / 86400000)
                : null;
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--glass)", borderRadius: "var(--r)", border: "1px solid var(--line)" }}>
                  <span style={{ width: 28, height: 28, flexShrink: 0, borderRadius: "50%", background: "var(--glass-2)", border: "1px solid var(--line-strong)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--narrow)", fontWeight: 600, fontSize: 11, color: tagColor[p.tag] ?? "var(--ink-dim)" }}>
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, color: "var(--ink)", fontWeight: 500 }}>{p.name}</div>
                    {p.role && <div style={{ fontSize: 10, color: "var(--ink-faint)", marginTop: 1 }}>{p.role}</div>}
                  </div>
                  <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: daysLeft !== null && daysLeft <= 0 ? "var(--clay)" : "var(--ink-faint)", flexShrink: 0 }}>
                    {daysLeft === null ? "" : daysLeft <= 0 ? "overdue" : daysLeft === 0 ? "today" : `${daysLeft}d`}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </Card>
    </DraggableBlock>
  );

  const pomMin = Math.floor(pomSec / 60).toString().padStart(2, "0");
  const pomSecStr = (pomSec % 60).toString().padStart(2, "0");
  const pomIsDefault = pomSec === (pomMode === "work" ? 25 * 60 : 5 * 60);

  const pomodoroSection = (
    <DraggableBlock key="pomodoro" id="pomodoro">
      {blockSizes["pomodoro"] === "sm" ? (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "14px 8px 18px", gap: 10 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: pomMode === "work" ? "var(--clay)" : "var(--up)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
              {pomMode === "work" ? "FOCUS" : "BREAK"}{pomBlocks > 0 ? ` · ${pomBlocks}×` : ""}
            </div>
            <div style={{ fontFamily: "var(--narrow)", fontSize: 42, fontWeight: 700, letterSpacing: "-0.02em", color: pomMode === "work" ? "var(--clay)" : "var(--up)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {pomMin}:{pomSecStr}
            </div>
            <div style={{ display: "flex", gap: 5 }}>
              <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: "4px 12px" }} onClick={() => setPomRunning((r) => !r)}>
                {pomRunning ? "Pause" : pomIsDefault ? "Start" : "Resume"}
              </button>
              <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => { setPomRunning(false); setPomMode("work"); pomModeRef.current = "work"; setPomSec(25 * 60); }}>
                ↺
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <h2 className="sec">
            Pomodoro<span className="rule" />
            <span className="count" style={{ color: pomMode === "work" ? "var(--clay)" : "var(--up)" }}>
              {pomMode === "work" ? "Focus" : "Break"}{pomBlocks > 0 ? ` · ${pomBlocks} today` : ""}
            </span>
          </h2>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: "var(--narrow)", fontSize: 52, fontWeight: 700, letterSpacing: "-0.02em", color: pomMode === "work" ? "var(--clay)" : "var(--up)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {pomMin}:{pomSecStr}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn-secondary" style={{ minWidth: 68 }} onClick={() => setPomRunning((r) => !r)}>
                {pomRunning ? "Pause" : pomIsDefault ? "Start" : "Resume"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => { setPomRunning(false); setPomMode("work"); pomModeRef.current = "work"; setPomSec(25 * 60); }}>
                Reset
              </button>
              <button type="button" className="btn-secondary" style={{ fontSize: 10 }} onClick={() => { const next: "work" | "break" = pomMode === "work" ? "break" : "work"; setPomRunning(false); setPomMode(next); pomModeRef.current = next; setPomSec(next === "work" ? 25 * 60 : 5 * 60); }}>
                {pomMode === "work" ? "→ Break" : "→ Work"}
              </button>
            </div>
            {pomBlocks > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", alignItems: "center" }}>
                {Array.from({ length: Math.min(pomBlocks, 12) }).map((_, i) => (
                  <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--clay)", opacity: 0.65 }} />
                ))}
                {pomBlocks > 12 && <span style={{ fontSize: 9, color: "var(--ink-faint)", fontFamily: "var(--mono)", lineHeight: "7px" }}>+{pomBlocks - 12}</span>}
              </div>
            )}
          </div>
        </Card>
      )}
    </DraggableBlock>
  );

  const sectionMap: Record<SectionId, React.ReactNode> = {
    "widgets": widgetsSection,
    "photos": photosSection,
    "dispatch-block": dispatchBlockSection,
    "pomodoro": pomodoroSection,
    "routine": routineSection,
    "daily-rings": dailyRingsSection,
    "todays-arc": todaysArcSection,
    "focus-ranked": focusRankedSection,
    "people-spotlight": peopleSpotlightSection,
    "weekly-devotional": weeklyDevotionalSection,
    "stoic-maxim": stoicMaximSection,
    "markets-body": marketsBodySection,
    "art-gallery": artGallerySection,
  };

  // Minimal clone for DragOverlay — just a dim placeholder matching the handle
  const overlayNode = activeDragId ? (
    <div
      style={{
        background: "var(--glass-2)",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--rl)",
        padding: "12px 16px",
        opacity: 0.7,
        backdropFilter: "var(--blur)",
        WebkitBackdropFilter: "var(--blur)",
        color: "var(--ink-dim)",
        fontSize: 12,
        fontFamily: "var(--narrow)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: "grabbing",
      }}
    >
      {activeDragId.replace(/-/g, " ")}
    </div>
  ) : null;

  return (
    <>
      {/* Scoped freeform-grid styles (this unit must not touch globals.css).
          Structured 2-up grid that snaps cards to slots; collapses to a single
          column on narrow viewports so the layout never overflows. */}
      <style>{`
        .console-grid {
          display: grid;
          /* 4-col base grid gives three size steps (sm = 1, md = 2, full = 4
             columns) for more granular resizing than a binary half/full split. */
          grid-template-columns: repeat(4, minmax(0, 1fr));
          /* Plain row flow (NOT "dense"): dense back-fills gaps, which makes the
             visual order diverge from DOM order and breaks dnd-kit's drop math —
             dragging a block to the right would land it somewhere else. With
             plain row flow, where you drop is where it stays. */
          grid-auto-flow: row;
          gap: var(--section-gap);
          margin-top: var(--space-3);
          align-items: start;
        }
        @media (max-width: 900px) {
          .console-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .console-grid > .block-wrap.block-sm { grid-column: span 1; }
          .console-grid > .block-wrap.block-md,
          .console-grid > .block-wrap:not(.block-sm):not(.block-md) { grid-column: 1 / -1; }
        }
        @media (max-width: 680px) {
          .console-grid { grid-template-columns: 1fr; }
          .console-grid > .block-wrap { grid-column: 1 / -1 !important; }
        }
      `}</style>
      <div className="eyebrow">{formatDateLong()}</div>
      <HeroLine tasks={tasks} />

      <div className="capture" style={{ marginTop: "var(--section-gap)" }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <input
          placeholder="Capture a thought, task, paper, or expense…"
          value={captureText}
          onChange={(e) => setCaptureText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCapture()}
        />
        {(["task", "note", "paper"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`capt-pill${captMode === m ? " on" : ""}`}
            onClick={() => setCaptMode(captMode === m ? null : m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
        <button type="button" className="capt-go" onClick={handleCapture}>Capture</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: "var(--section-gap)" }}>
        <span style={{ marginRight: "auto", fontSize: 10, fontFamily: "var(--mono)", color: "var(--ink-faint)", letterSpacing: ".06em" }}>
          Drag ⠿ to rearrange · click ⊞/⊡/⊟ to cycle size
        </span>
        <button type="button" className="feed-manage" onClick={resetLayout}>Reset layout</button>
      </div>

      <BlockSizeContext.Provider value={{ sizes: blockSizes, toggle: toggleBlockSize }}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sectionOrder} strategy={rectSortingStrategy}>
            <div className="console-grid">
              {sectionOrder.map((id) => sectionMap[id])}
            </div>
          </SortableContext>
          <DragOverlay>{overlayNode}</DragOverlay>
        </DndContext>
      </BlockSizeContext.Provider>

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose Widget" footer={<Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>}>
        <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 12 }}>
          Select a widget for slot {swapIdx !== null ? swapIdx + 1 : "—"}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" }}>
          {WIDGET_CATALOG.map((w) => {
            const isActive = widgetIds.includes(w.id);
            const isCurrent = swapIdx !== null && widgetIds[swapIdx] === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  if (swapIdx === null) return;
                  const next = [...widgetIds];
                  next[swapIdx] = w.id;
                  setWidgetIds(next);
                  save(next, widgetTexts);
                  setPickerOpen(false);
                  setSwapIdx(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "9px 12px",
                  border: `1px solid ${isCurrent ? "var(--accent)" : "var(--line)"}`,
                  borderRadius: "var(--r)",
                  background: isCurrent ? "var(--glass-2)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "border-color 0.14s, background 0.14s",
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1, width: 24, textAlign: "center", color: "var(--gold)", fontFamily: "var(--mono)" }}>{w.icon}</span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{w.label}</span>
                  <span style={{ display: "block", fontSize: 11, color: "var(--ink-faint)", marginTop: 1 }}>{w.hint}</span>
                </span>
                {w.category && (
                  <span style={{ fontSize: 9.5, fontFamily: "var(--narrow)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-faint)", border: "1px solid var(--line)", borderRadius: 2, padding: "1px 5px" }}>
                    {w.category}
                  </span>
                )}
                {isActive && !isCurrent && (
                  <span style={{ fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--accent)", opacity: 0.7 }}>active</span>
                )}
              </button>
            );
          })}
        </div>
      </Modal>
    </>
  );
}
