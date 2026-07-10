"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
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
import { DEFAULT_WIDGET_IDS, WIDGET_CATALOG, normalizeConsoleLayout, BLOCK_SIZES, type BlockSize } from "@/lib/store/widgets";
import { formatDateLong } from "@/lib/format";
import { fetchTodayMergedEvents } from "@/lib/calendar/today-events";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { ConsoleCaptureBar } from "@/components/console/ConsoleCaptureBar";
import { FeaturedPhotos } from "@/components/console/FeaturedPhotos";
import { WidgetGrid } from "@/components/console/WidgetGrid";
import { CONSOLE_SECTION_DRILL_INS, taskRingProgress, type ConsoleDrillInSection } from "@/components/console/widget-grid-model";
import { callAiAction } from "@/lib/ai/callAction";
import { useWidgetData } from "@/lib/hooks/useWidgetData";
import { isSignalActionable, isSignalVisible, useSignals } from "@/lib/hooks/useSignals";
import { rankTasks, useTasks, type Task } from "@/lib/hooks/useTasks";
import { useNotes } from "@/lib/hooks/useNotes";
import { usePeople } from "@/lib/hooks/usePeople";
import { Card } from "@/components/ui/Card";
import { AxisGlassPanel } from "@/components/ui/axis/AxisGlassPanel";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";

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
    <Card className="console-premium-card">
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
const CONSOLE_BLOCK_COLUMNS_KEY = "axis-console-block-columns";
const BLOCK_COL_SPAN: Record<BlockSize, number> = { sm: 1, md: 2, full: 4 };
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

type BlockSizeCtx = {
  sizes: Record<string, BlockSize>;
  columns: Partial<Record<string, number>>;
  toggle: (id: string) => void;
  nudgeColumn: (id: string, dir: -1 | 1) => void;
};
const BlockSizeContext = createContext<BlockSizeCtx>({ sizes: {}, columns: {}, toggle: () => {}, nudgeColumn: () => {} });

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
  const { sizes, columns, toggle, nudgeColumn } = useContext(BlockSizeContext);
  const size = sizes[id] ?? "full";
  const span = BLOCK_COL_SPAN[size];
  const colStart = columns[id];
  const maxStart = Math.max(1, 5 - span);
  const validStart = colStart && colStart <= maxStart ? colStart : undefined;
  const reduceMotion = useReducedMotion();
  const gridColumn = validStart
    ? `${validStart} / span ${span}`
    : BLOCK_SPAN[size];
  return (
    <motion.div
      ref={setNodeRef}
      className={`block-wrap${size !== "full" ? ` block-${size}` : ""}`}
      layout={!reduceMotion && !isDragging ? "position" : false}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 2 : 1,
        position: "relative",
        gridColumn,
        minWidth: 0,
      }}
    >
      <div className="block-controls">
        <button
          type="button"
          onClick={() => nudgeColumn(id, -1)}
          className="console-block-control"
          aria-label={`Move ${id.replace(/-/g, " ")} block left`}
          title="Nudge left"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => toggle(id)}
          className="console-block-control"
          aria-label={`Resize ${id.replace(/-/g, " ")} block. Current size: ${BLOCK_SIZE_LABEL[size]}.`}
          title={`${BLOCK_SIZE_LABEL[size]} — click to resize`}
        >
          {BLOCK_SIZE_GLYPH[size]}
        </button>
        <button
          type="button"
          onClick={() => nudgeColumn(id, 1)}
          className="console-block-control"
          aria-label={`Move ${id.replace(/-/g, " ")} block right`}
          title="Nudge right"
        >
          →
        </button>
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="block-drag-handle console-block-control"
          aria-label={`Move ${id.replace(/-/g, " ")} block`}
          title="Drag or use keyboard arrows to move the block"
        >
          <span className="block-drag-grip">⠿</span>
        </button>
      </div>
      {children}
    </motion.div>
  );
}

function SectionDrillIn({ section }: { section: ConsoleDrillInSection }) {
  const drillIn = CONSOLE_SECTION_DRILL_INS[section];

  return (
    <Link
      href={drillIn.href}
      className="feed-manage console-drill-in"
      aria-label={drillIn.label}
    >
      Open
    </Link>
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
  const [blockColumns, setBlockColumns] = useState<Partial<Record<SectionId, number>>>({});
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
      const storedCols = localStorage.getItem(CONSOLE_BLOCK_COLUMNS_KEY);
      if (storedCols) {
        const parsedCols = JSON.parse(storedCols) as Record<string, number>;
        const validCols: Partial<Record<SectionId, number>> = {};
        for (const [id, col] of Object.entries(parsedCols)) {
          if (col >= 1 && col <= 4) validCols[id as SectionId] = col;
        }
        setBlockColumns((prev) => ({ ...prev, ...validCols }));
      }
    } catch { /* ignore */ }
  }, []);

  // Debounced auto-save of the freeform layout (order + per-block sizes).
  // Always mirrors to localStorage; additionally persists to the `layout` jsonb
  // column when it exists. If the column isn't applied yet, the first write
  // detects the schema error, flips layoutColumnRef off, and we degrade to
  // localStorage-only — the drag/snap UX is unaffected either way.
  const persistLayout = useCallback(
    (order: SectionId[], sizes: Record<SectionId, BlockSize>, columns: Partial<Record<SectionId, number>>) => {
      try { localStorage.setItem(CONSOLE_SECTION_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
      try { localStorage.setItem(CONSOLE_BLOCK_SIZES_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }
      try { localStorage.setItem(CONSOLE_BLOCK_COLUMNS_KEY, JSON.stringify(columns)); } catch { /* ignore */ }

      if (!layoutColumnRef.current) return;
      if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
      layoutSaveTimer.current = setTimeout(async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { error } = await supabase.from("console_widgets").upsert(
          {
            user_id: user.id,
            layout: { order, sizes, columns },
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
    setBlockSizes((prevSizes) => {
      const current = prevSizes[id as SectionId] ?? "full";
      const nextSize = NEXT_BLOCK_SIZE[current];
      const nextSizes = { ...prevSizes, [id]: nextSize } as Record<SectionId, BlockSize>;
      setBlockColumns((prevCols) => {
        const span = BLOCK_COL_SPAN[nextSize];
        const col = prevCols[id as SectionId];
        const nextCols = { ...prevCols };
        if (col !== undefined) {
          const maxStart = Math.max(1, 5 - span);
          if (span >= 4 || col > maxStart) {
            delete nextCols[id as SectionId];
          } else if (col > maxStart) {
            nextCols[id as SectionId] = maxStart;
          }
        }
        persistLayout(sectionOrder, nextSizes, nextCols);
        return nextCols;
      });
      return nextSizes;
    });
  }, [persistLayout, sectionOrder]);

  const nudgeColumn = useCallback((id: string, dir: -1 | 1) => {
    setBlockColumns((prev) => {
      const size = blockSizes[id as SectionId] ?? "full";
      const span = BLOCK_COL_SPAN[size];
      const current = prev[id as SectionId] ?? 1;
      const nextCol = Math.min(5 - span, Math.max(1, current + dir));
      const next = { ...prev, [id]: nextCol } as Record<SectionId, number>;
      persistLayout(sectionOrder, blockSizes, next);
      return next;
    });
  }, [blockSizes, persistLayout, sectionOrder]);

  const resetLayout = useCallback(() => {
    const order: SectionId[] = [...DEFAULT_SECTION_ORDER];
    const sizes: Record<SectionId, BlockSize> = { ...DEFAULT_BLOCK_SIZES };
    const columns: Partial<Record<SectionId, number>> = {};
    setSectionOrder(order);
    setBlockSizes(sizes);
    setBlockColumns(columns);
    persistLayout(order, sizes, columns);
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
        if (layout.columns) {
          setBlockColumns((prev) => ({ ...prev, ...(layout.columns as Record<SectionId, number>) }));
        }
      }
    }

    try {
      const merged = await fetchTodayMergedEvents(supabase, user.id);
      setArcEvents(merged.map((event) => ({
        id: event.id,
        title: event.title,
        start_at: event.start_at,
        end_at: event.end_at,
      })));
    } catch {
      setArcEvents([]);
    }

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

    // Classify via the typed AI action (AI-3): validated input, typed output.
    void callAiAction("capture", { text }).then(async (result) => {
      const d = result.ok ? result.data : null;
      const priority = d?.priority ?? "med";

      // Save to tasks table if captMode is "task"
      if (captMode === "task") {
        await addTask({ title: text, category: "personal", priority });
        toast(d ? `Task · ${d.label} · ${d.action}` : "Task saved", "success", "Capture");
        return;
      }

      // Save to notes table if captMode is "note"
      if (captMode === "note") {
        await createNote(text, "Inbox");
        toast(d ? `Note · ${d.label}` : "Note saved", "success", "Capture");
        return;
      }

      // Default: show AI classification toast
      if (d) {
        toast(`${d.label} · ${d.action}`, "info", "AI");
      } else {
        toast("Captured to Signals inbox", "success", "Console");
      }
    });
  };

  const handleTriage = async (s: { id: string; title: string; body: string | null; source: string }) => {
    setTriagingIds((prev) => new Set(prev).add(s.id));
    try {
      const result = await callAiAction("triage", { text: s.title, body: s.body ?? "" });
      if (result.ok) {
        const d = result.data;
        await applyClassification(s.id, {
          signal_type: "action",
          priority: d.priority,
          destination: d.category,
          reason: `${d.category} · ${d.effort}`,
          confidence: 0.8,
        });
        toast(`Triaged · ${d.priority.toUpperCase()} · ${d.category} · ${d.effort}`, "info", "AI");
      } else {
        toast("Triage failed — check connection", "error", "AI");
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
      persistLayout(next, blockSizes, blockColumns);
      return next;
    });
  };

  if (loading) return <div className="empty-state">Loading console…</div>;

  // ── section render map ──────────────────────────────────────────

  const widgetsSection = (
    <DraggableBlock key="widgets" id="widgets">
      <AxisGlassPanel className="module-glass-zone command-widget-zone">
        <WidgetGrid
          widgetIds={widgetIds}
          widgetTexts={widgetTexts}
          liveData={liveData}
          editing={editing}
          expandedWidget={expandedWidget}
          detailWidgetId={detailWidgetId}
          onEditingChange={setEditing}
          onExpandedWidgetChange={setExpandedWidget}
          onDetailWidgetChange={setDetailWidgetId}
          onWidgetTextsChange={setWidgetTexts}
          onSwapIndexChange={setSwapIdx}
          onPickerOpenChange={setPickerOpen}
          onSave={save}
          onRefreshOne={refreshOne}
          onRefreshAll={refreshAll}
          onToast={toast}
        />
      </AxisGlassPanel>
    </DraggableBlock>
  );

  const photosSection = (
    <DraggableBlock key="photos" id="photos">
      <AxisGlassPanel className="module-glass-zone command-photo-zone">
        <FeaturedPhotos />
      </AxisGlassPanel>
    </DraggableBlock>
  );

  const taskRing = taskRingProgress(tasks);

  const dailyRingsSection = (
    <DraggableBlock key="daily-rings" id="daily-rings">
      <Card tick className="console-premium-card">
        <h2 className="sec">Daily Rings<span className="rule" /><span className="count">Tasks live · labs/disconnected</span><SectionDrillIn section="daily-rings" /></h2>
        <div className="rings-wrap">
          <svg className="rings" viewBox="0 0 120 120">
            <circle className="rbg" cx="60" cy="60" r="52" /><circle className="rfg r1" cx="60" cy="60" r="52" style={{ strokeDashoffset: 326.7 }} />
            <circle className="rbg" cx="60" cy="60" r="40" /><circle className="rfg r2" cx="60" cy="60" r="40" style={{ strokeDashoffset: 251.3 }} />
            <circle className="rbg" cx="60" cy="60" r="28" /><circle className="rfg r3" cx="60" cy="60" r="28" style={{ strokeDashoffset: taskRing.strokeDashoffset }} />
          </svg>
          <div className="rings-legend">
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--accent)" }} /><span className="rl-name">Deep work</span><span className="rl-v">Lab · no persisted source</span></div>
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--up)" }} /><span className="rl-name">Movement</span><span className="rl-v">Disconnected · connect Strava</span></div>
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--marine)" }} /><span className="rl-name">Tasks</span><span className="rl-v">{taskRing.label}</span></div>
          </div>
        </div>
      </Card>
    </DraggableBlock>
  );

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const todaysArcSection = (
    <DraggableBlock key="todays-arc" id="todays-arc">
      <Card tick className="console-premium-card">
        <h2 className="sec">Today&apos;s Arc<span className="rule" /><span className="count">{arcEvents.length || "Schedule"}</span><SectionDrillIn section="todays-arc" /></h2>
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
      <Card className="console-premium-card">
        <h2 className="sec">Focus · Ranked<span className="rule" /><span className="count">Top {topTasks.length || 3}</span><SectionDrillIn section="focus-ranked" /></h2>
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
      <Card tick className="devo console-premium-card">
        <div className="eyebrow" style={{ color: "var(--clay)" }}>Weekly Devotional · Static local reference</div>
        <div className="verse">&ldquo;Whatever you do, work heartily, as for the Lord and not for men.&rdquo;</div>
        <div className="ref">COLOSSIANS 3:23 · ESV</div>
      </Card>
    </DraggableBlock>
  );

  const todayQuote = DAILY_REFLECTIONS[Math.floor(Date.now() / 86400000) % DAILY_REFLECTIONS.length];

  const stoicMaximSection = (
    <DraggableBlock key="stoic-maxim" id="stoic-maxim">
      <Card tick className="quote-card console-premium-card">
        <div className="eyebrow" style={{ color: "var(--accent-2)" }}>Daily Reflection · Static local</div>
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
      <Card className="console-premium-card">
        <h2 className="sec">
          Markets<span className="rule" />
          <span className="count">
            {liveData.markets?.error ? "Stale" : liveData.markets?.updatedAt ? "Live" : "Setup required"}
          </span>
          <SectionDrillIn section="markets-body" />
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
      <Card className="console-premium-card">
        <h2 className="sec">
          Dispatch
          <span className="rule" />
          <span className="count" style={{ color: unread > 0 ? "var(--clay)" : "var(--up)" }}>
            {unread > 0 ? `${unread} unread` : "Clear"}
          </span>
          <SectionDrillIn section="dispatch-block" />
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
      <Card className="console-premium-card">
        <h2 className="sec">
          {routineLabel}
          <span className="rule" />
          <span className="count" style={{ color: routineColor }}>
            Local heuristic · {checkedItems.size}/{routineItems.length}
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
      <Card className="console-premium-card">
        <h2 className="sec">
          People · Follow-Up
          <span className="rule" />
          <span className="count" style={{ color: duePeople.length > 0 ? "var(--clay)" : "var(--up)" }}>
            {duePeople.length > 0 ? `${duePeople.length} due` : "All good"}
          </span>
          <SectionDrillIn section="people-spotlight" />
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
        <Card className="console-premium-card">
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
        <Card className="console-premium-card">
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
        .module-hero-shell .capture {
          margin-top: 18px;
        }
        html.light .module-hero-shell .capture {
          background: color-mix(in srgb, var(--glass-2) 88%, white 12%);
          border-color: color-mix(in srgb, var(--line-strong) 80%, var(--axis-glass-border));
        }
        html.light .module-hero-shell .capture input,
        html.light .module-hero-shell .capture input::placeholder {
          color: color-mix(in srgb, var(--ink) 82%, var(--ink-faint));
        }
        .command-photo-zone .photostrip-top,
        .command-widget-zone .tidbits {
          margin-top: 0;
        }
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
        .console-grid h2.sec {
          flex-wrap: wrap;
          gap: 6px;
          min-width: 0;
        }
        .console-grid h2.sec .rule {
          min-width: 24px;
        }
        .console-grid h2.sec .count {
          min-width: 0;
          white-space: normal;
          text-align: right;
        }
        .console-drill-in {
          margin-left: 0;
          text-decoration: none;
          flex-shrink: 0;
        }
        .console-block-control {
          min-width: 28px;
          min-height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: none;
          border: 0;
          border-radius: var(--r);
          color: var(--ink-faint);
          cursor: grab;
          line-height: 1;
          padding: 0;
          touch-action: none;
        }
        .console-block-control:first-child {
          cursor: pointer;
          font-size: 13px;
        }
        .block-controls .block-drag-handle.console-block-control {
          opacity: 1;
        }
        .console-block-control:focus-visible,
        .console-drill-in:focus-visible,
        .console-grid .tb:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 3px;
        }
        .block-wrap:focus-within .block-controls {
          opacity: 1;
        }
        @media (max-width: 900px) {
          .console-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .console-grid > .block-wrap.block-sm { grid-column: span 1; }
          .console-grid > .block-wrap.block-md,
          .console-grid > .block-wrap:not(.block-sm):not(.block-md) { grid-column: 1 / -1; }
          .console-grid h2.sec .rule {
            flex-basis: 24px;
          }
        }
        @media (max-width: 680px) {
          .console-grid { grid-template-columns: 1fr; }
          .console-grid > .block-wrap { grid-column: 1 / -1 !important; }
          .console-grid h2.sec {
            align-items: flex-start;
          }
          .console-grid h2.sec .count {
            flex-basis: 100%;
            order: 3;
            text-align: left;
          }
          .console-drill-in {
            margin-left: auto;
          }
          .block-controls {
            opacity: 1;
          }
          .console-block-control {
            min-width: 36px;
            min-height: 36px;
          }
        }
      `}</style>
      <div className="module-stage">
        <AxisReflectiveCard className="module-hero-shell">
          <div className="eyebrow">{formatDateLong()}</div>
          <HeroLine tasks={tasks} />

          <ConsoleCaptureBar
            value={captureText}
            mode={captMode}
            onValueChange={setCaptureText}
            onModeChange={setCaptMode}
            onCapture={handleCapture}
          />
        </AxisReflectiveCard>

        <div className="module-layout-tools">
          <span className="module-layout-hint">
            Drag ⠿ to rearrange · ← → to nudge · click ⊞/⊡/⊟ to cycle size
          </span>
          <button type="button" className="feed-manage" onClick={resetLayout}>Reset layout</button>
        </div>

        <BlockSizeContext.Provider value={{ sizes: blockSizes, columns: blockColumns, toggle: toggleBlockSize, nudgeColumn }}>
          <DndContext
            id="console-widget-grid"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sectionOrder} strategy={rectSortingStrategy}>
              <div className="console-grid" data-testid="console-grid">
                {sectionOrder.map((id) => sectionMap[id])}
              </div>
            </SortableContext>
            <DragOverlay>{overlayNode}</DragOverlay>
          </DndContext>
        </BlockSizeContext.Provider>
      </div>

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
