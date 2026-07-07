"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import { useToast } from "@/components/ui/Toast";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { useAtelierPrefs } from "@/lib/hooks/useAtelierPrefs";

type LangKey = "fr" | "es" | "yo";

const LANGS: { key: LangKey; flag: string; label: string; lv: string }[] = [
  { key: "fr", flag: "🇫🇷", label: "French", lv: "B2 → C1" },
  { key: "es", flag: "🇪🇸", label: "Spanish", lv: "Medical" },
  { key: "yo", flag: "🟢", label: "Yoruba", lv: "Foundation" },
];

type Resource = { pinned: boolean; label: string; type: string; url: string };

const LANG_DATA: Record<
  LangKey,
  { name: string; lessons: [string, string, string][]; resources: Resource[] }
> = {
  fr: {
    name: "French",
    lessons: [
      ["TUE", "RFI — skim one article", "8 min · input"],
      ["THU", "C1 connector drill", "5 min · Anki"],
      ["SAT", "InnerFrench — shadow 1 clip", "10 min · speaking"],
    ],
    resources: [
      { pinned: true, label: "InnerFrench — intermediate podcast", type: "AUDIO", url: "https://innerfrench.com/episodes/" },
      { pinned: true, label: "RFI — free daily news (no paywall)", type: "READ", url: "https://www.rfi.fr/fr/" },
      { pinned: false, label: "Kwiziq — adaptive C1 grammar", type: "DRILL", url: "https://kwiziq.com/" },
      { pinned: false, label: "Italki — conversation tutors", type: "SPEAK", url: "https://www.italki.com/" },
    ],
  },
  es: {
    name: "Spanish",
    lessons: [
      ["MON", "Medical phrase of the day", "5 min · clinical"],
      ["WED", "Patient-instruction lines", "8 min · speaking"],
      ["SAT", "Symptom vocabulary set", "7 min · Anki"],
    ],
    resources: [
      { pinned: true, label: "MedlinePlus en español — clinical reading", type: "CLINICAL", url: "https://medlineplus.gov/spanish/" },
      { pinned: true, label: "Notes in Spanish — free podcast", type: "AUDIO", url: "https://www.notesinspanish.com/" },
      { pinned: false, label: "SpanishDict — conjugation", type: "DRILL", url: "https://www.spanishdict.com/conjugate" },
      { pinned: false, label: "Italki — medical tutors", type: "SPEAK", url: "https://www.italki.com/" },
    ],
  },
  yo: {
    name: "Yoruba",
    lessons: [
      ["TUE", "Tone pair drill", "6 min · phonics"],
      ["THU", "Greetings & honorifics", "7 min · culture"],
      ["SUN", "Shadow one Yoruba song", "10 min · listening"],
    ],
    resources: [
      { pinned: true, label: "YorubaName — pronunciation", type: "AUDIO", url: "https://www.yorubaname.com/" },
      { pinned: true, label: "Yoruba101 — structured lessons", type: "COURSE", url: "https://www.yoruba101.com/" },
      { pinned: false, label: "BBC Yoruba — news", type: "READ", url: "https://www.bbc.com/yoruba" },
      { pinned: false, label: "Tandem — language partners", type: "SPEAK", url: "https://www.tandem.net/" },
    ],
  },
};

// Free, no-auth RSS feeds backing each language's "Pinned Resources" READ items —
// fetched via the same generic feed proxy BriefingModule/LiteratureModule use,
// so the "Auto-refreshes weekly" caption is literally true.
const LANG_FEEDS: Record<LangKey, string[]> = {
  fr: ["https://www.rfi.fr/fr/rss"],
  es: ["https://www.notesinspanish.com/feed/"],
  yo: ["https://feeds.bbci.co.uk/yoruba/rss.xml"],
};

const MENS_STYLE_FEEDS: string[] = [
  "https://www.esquire.com/rss/all.xml/",
  "https://www.permanentstyle.com/feed",
  "https://www.gq.com/feed/rss",
  "https://hespokestyle.com/feed/",
];

type RssItem = { id: string; title: string; url: string; source: string; date: string };

function relAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 60) return mins <= 1 ? "now" : `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

const MOOD_TILES = [
  { height: 150, background: "linear-gradient(135deg,#2a2620,#14110d)" },
  { height: 110, background: "linear-gradient(135deg,#222a30,#11161b)" },
  { height: 130, background: "linear-gradient(135deg,#2c2622,#15110e)" },
  { height: 120, background: "linear-gradient(135deg,#262a28,#121514)" },
  { height: 140, background: "linear-gradient(135deg,#28242c,#131017)" },
  { height: 100, background: "linear-gradient(135deg,#2a2724,#14110f)" },
  { height: 130, background: "linear-gradient(135deg,#212830,#10141b)" },
  { height: 115, background: "linear-gradient(135deg,#2b2620,#15110c)" },
];

type MoodImage = { id: string; image_url: string; sort_order: number };

function initialPins() {
  const pins: Record<string, boolean> = {};
  (Object.keys(LANG_DATA) as LangKey[]).forEach((k) => {
    LANG_DATA[k].resources.forEach((r, i) => {
      pins[`${k}:${i}`] = r.pinned;
    });
  });
  return pins;
}

function dayToIso(abbrev: string, hour = 8): { start: string; end: string } {
  const map: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const target = map[abbrev.toUpperCase()] ?? 1;
  const now = new Date();
  let diff = (target - now.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  const d = new Date(now);
  d.setDate(d.getDate() + diff);
  d.setHours(hour, 0, 0, 0);
  const start = new Date(d);
  const end = new Date(d.getTime() + 30 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function SortableMoodTile({
  img,
  height,
  onRemove,
}: {
  img: MoodImage;
  height: number;
  onRemove: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: img.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        height,
        background: `url(${img.image_url}) center/cover`,
        backgroundPosition: "center",
        position: "relative",
        borderRadius: "var(--r)",
        border: "1px solid var(--line)",
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 2 : 1,
        cursor: "grab",
        touchAction: "none",
      }}
    >
      <span
        role="button"
        tabIndex={0}
        title="Remove image"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(img.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            onRemove(img.id);
          }
        }}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontSize: 12,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ×
      </span>
    </div>
  );
}

export function AtelierModule() {
  const { toast } = useToast();
  const { open: openInApp } = useWebViewer();
  const [tab, setTab] = useState<"atl-lang" | "atl-style">("atl-lang");
  const [lang, setLang] = useState<LangKey>("fr");
  const [addingAgenda, setAddingAgenda] = useState(false);
  const { pins, togglePin } = useAtelierPrefs(initialPins());

  const [moodImages, setMoodImages] = useState<MoodImage[]>([]);
  const moodInputRef = useRef<HTMLInputElement>(null);

  const [langFeedItems, setLangFeedItems] = useState<Record<LangKey, RssItem[]>>({ fr: [], es: [], yo: [] });
  const [trendItems, setTrendItems] = useState<RssItem[]>([]);
  const [trendsLoading, setTrendsLoading] = useState(true);
  const [trendsRefreshing, setTrendsRefreshing] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadMoodImages = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: rows } = await supabase
      .from("moodboard_images")
      .select("id,image_url,sort_order")
      .eq("user_id", user.id)
      .order("sort_order");
    setMoodImages((rows ?? []) as MoodImage[]);
  }, []);

  useEffect(() => {
    loadMoodImages();
  }, [loadMoodImages]);

  const addMoodImage = async (file: File) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast("Sign in to save moodboard images.", "warn", "Atelier"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const image_url = reader.result as string;
      const { data: row, error } = await supabase
        .from("moodboard_images")
        .insert({ user_id: user.id, image_url, sort_order: moodImages.length })
        .select("id,image_url,sort_order")
        .single();
      if (error) toast("Failed to add image.", "error", "Atelier");
      else if (row) setMoodImages((p) => [...p, row as MoodImage]);
    };
    reader.readAsDataURL(file);
  };

  const removeMoodImage = async (id: string) => {
    const supabase = createClient();
    const { error } = await supabase.from("moodboard_images").delete().eq("id", id);
    if (error) { toast("Failed to remove image.", "error", "Atelier"); return; }
    setMoodImages((p) => p.filter((img) => img.id !== id));
  };

  // Persist the new ordering to moodboard_images, scoped to the signed-in user.
  // `ordered` already carries each row's target sort_order (= its array index);
  // we write only rows whose position changed from `prev`.
  const persistMoodOrder = useCallback(
    async (ordered: MoodImage[], prev: MoodImage[]) => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast("Sign in to save the moodboard order.", "warn", "Atelier"); return; }
      const prevOrder = new Map(prev.map((img) => [img.id, img.sort_order]));
      const changed = ordered.filter((img) => prevOrder.get(img.id) !== img.sort_order);
      if (changed.length === 0) return;
      const results = await Promise.all(
        changed.map((img) =>
          supabase
            .from("moodboard_images")
            .update({ sort_order: img.sort_order })
            .eq("id", img.id)
            .eq("user_id", user.id),
        ),
      );
      if (results.some((r) => r.error)) {
        toast("Failed to save the new order.", "error", "Atelier");
        void loadMoodImages();
      }
    },
    [toast, loadMoodImages],
  );

  const handleMoodDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setMoodImages((prev) => {
      const oldIndex = prev.findIndex((img) => img.id === active.id);
      const newIndex = prev.findIndex((img) => img.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const reordered = arrayMove(prev, oldIndex, newIndex).map((img, i) => ({
        ...img,
        sort_order: i,
      }));
      void persistMoodOrder(reordered, prev);
      return reordered;
    });
  };

  // ── Pinned-resources "auto-refresh" feeds, keyed per language, and the
  // Men's-Style trends card — both backed by the same generic, auth-checked,
  // SSRF-guarded RSS proxy BriefingModule/LiteratureModule already use.
  const loadFeed = useCallback(async (feedUrls: string[]): Promise<RssItem[]> => {
    try {
      const res = await fetch("/api/feeds/cached", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedUrls }),
      });
      if (!res.ok) return [];
      const json = await res.json();
      return Array.isArray(json.items) ? (json.items as RssItem[]) : [];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadAllLangFeeds = async () => {
      const keys = Object.keys(LANG_FEEDS) as LangKey[];
      const results = await Promise.all(keys.map((k) => loadFeed(LANG_FEEDS[k])));
      if (cancelled) return;
      const next = {} as Record<LangKey, RssItem[]>;
      keys.forEach((k, i) => { next[k] = results[i]; });
      setLangFeedItems(next);
    };
    loadAllLangFeeds();
    const id = setInterval(loadAllLangFeeds, 4 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [loadFeed]);

  // Shared loader for the Men's-Style trends card. The silent 4-min interval
  // and the manual "Refresh" button both call this; the button sets a visible
  // refreshing state while in flight.
  const loadTrends = useCallback(async () => {
    const items = await loadFeed(MENS_STYLE_FEEDS);
    setTrendItems(items.slice(0, 4));
    setTrendsLoading(false);
  }, [loadFeed]);

  const refreshTrends = useCallback(async () => {
    setTrendsRefreshing(true);
    try {
      await loadTrends();
    } finally {
      setTrendsRefreshing(false);
    }
  }, [loadTrends]);

  useEffect(() => {
    void loadTrends();
    const id = setInterval(() => { void loadTrends(); }, 4 * 60 * 1000);
    return () => { clearInterval(id); };
  }, [loadTrends]);

  const addWeekToAgenda = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast("Sign in to add lessons to your agenda.", "warn", "Atelier"); return; }
    setAddingAgenda(true);
    const events = data.lessons.map(([day, title]) => {
      const { start, end } = dayToIso(day);
      return { user_id: user.id, title: `${data.name} · ${title}`, start_at: start, end_at: end, color_class: "accent", recurrence_rule: null };
    });
    const { error } = await supabase.from("schedule_events").insert(events);
    setAddingAgenda(false);
    if (error) toast("Failed to add events.", "error", "Atelier");
    else toast(`${events.length} lessons added to this week's agenda.`, "success", "Atelier");
  };

  const data = LANG_DATA[lang];
  const langFeedForCurrent = langFeedItems[lang] ?? [];

  return (
    <>
        <div className="savebtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
          Add a Pursuit
      </div>

      <div className="subtabbar" style={{ marginTop: 20 }}>
        <button type="button" className={`subtab${tab === "atl-lang" ? " on" : ""}`} onClick={() => setTab("atl-lang")}>
          Languages
        </button>
        <button type="button" className={`subtab${tab === "atl-style" ? " on" : ""}`} onClick={() => setTab("atl-style")}>
          Style
        </button>
      </div>

      <div className={`subpanel${tab === "atl-lang" ? " on" : ""}`} id="atl-lang">
        <div className="langbar">
          {LANGS.map((l) => (
            <div key={l.key} className={`langbtn${lang === l.key ? " on" : ""}`} onClick={() => setLang(l.key)}>
              {l.flag} {l.label} <span className="lv">{l.lv}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card tick">
            <h2 className="sec">This Week&apos;s Lessons<span className="rule" /><span className="count">{data.name}</span></h2>
            <div style={{ marginTop: 14 }}>
              {data.lessons.map(([day, title, meta]) => (
                <div className="lessonrow" key={`${lang}-${day}-${title}`}>
                  <div className="ld">{day}</div>
                  <div className="lt">{title}</div>
                  <div className="lmeta">{meta}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <span
                className="aibtn"
                role="button"
                tabIndex={0}
                style={{ opacity: addingAgenda ? 0.5 : 1, cursor: addingAgenda ? "default" : "pointer" }}
                onClick={!addingAgenda ? addWeekToAgenda : undefined}
                onKeyDown={(e) => !addingAgenda && e.key === "Enter" && addWeekToAgenda()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
                {addingAgenda ? "Adding…" : "Add Week to Agenda"}
              </span>
            </div>
          </div>
          <div className="card">
            <h2 className="sec">Pinned Resources<span className="rule" /></h2>
            <div style={{ marginTop: 12 }}>
              {data.resources.map((r, i) => (
                <div className="resource" key={`${lang}-${r.label}`}>
                  <span
                    className={`pin${pins[`${lang}:${i}`] ? " on" : ""}`}
                    onClick={() => togglePin(`${lang}:${i}`)}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l2.6 6.3 6.8.5-5.2 4.4 1.7 6.6L12 17l-5.9 3.3 1.7-6.6L2.6 8.8l6.8-.5z" />
                    </svg>
                  </span>
                  <span
                    className="rl"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => openInApp(r.url, r.label)}
                    onKeyDown={(e) => e.key === "Enter" && openInApp(r.url, r.label)}
                  >
                    {r.label}
                  </span>
                  <span className="rt">{r.type}</span>
                </div>
              ))}
              {langFeedForCurrent.slice(0, 3).map((item) => (
                <div className="resource" key={item.id}>
                  <span className="pin" style={{ visibility: "hidden" }}>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l2.6 6.3 6.8.5-5.2 4.4 1.7 6.6L12 17l-5.9 3.3 1.7-6.6L2.6 8.8l6.8-.5z" />
                    </svg>
                  </span>
                  <span
                    className="rl"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => openInApp(item.url, item.title)}
                    onKeyDown={(e) => e.key === "Enter" && openInApp(item.url, item.title)}
                  >
                    {item.title}
                  </span>
                  <span className="rt">{relAge(item.date)}</span>
                </div>
              ))}
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 12 }}>
                Auto-refreshes weekly · click ★ to pin
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`subpanel${tab === "atl-style" ? " on" : ""}`} id="atl-style">
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card">
            <h2 className="sec">Moodboard<span className="rule" /><span className="count">{moodImages.length > 0 ? "Drag to rearrange" : "Drop images to add"}</span></h2>
            {moodImages.length === 0 ? (
              <div className="mood" style={{ marginTop: 14 }}>
                {MOOD_TILES.map((t, i) => (
                  <div key={i} style={{ height: t.height, background: t.background }} />
                ))}
              </div>
            ) : (
              <DndContext id="atelier-moodboard" sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMoodDragEnd}>
                <SortableContext items={moodImages.map((img) => img.id)} strategy={rectSortingStrategy}>
                  <div
                    style={{
                      marginTop: 14,
                      display: "grid",
                      gridTemplateColumns: "repeat(3, 1fr)",
                      gap: 12,
                    }}
                  >
                    {moodImages.map((img, i) => (
                      <SortableMoodTile
                        key={img.id}
                        img={img}
                        height={MOOD_TILES[i % MOOD_TILES.length].height}
                        onRemove={removeMoodImage}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
            <input
              ref={moodInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                Array.from(e.target.files ?? []).forEach(addMoodImage);
                e.target.value = "";
              }}
            />
            <div style={{ marginTop: 12 }}>
              <span className="savebtn" role="button" tabIndex={0} onClick={() => moodInputRef.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
                Add Images
              </span>
            </div>
          </div>
          <div className="card">
            <h2 className="sec">
              Men&apos;s Style — Trends<span className="rule" />
              <span
                className="count"
                role="button"
                tabIndex={0}
                style={{ cursor: trendsRefreshing ? "default" : "pointer", opacity: trendsRefreshing ? 0.5 : 1 }}
                onClick={!trendsRefreshing ? refreshTrends : undefined}
                onKeyDown={(e) => !trendsRefreshing && e.key === "Enter" && refreshTrends()}
              >
                {trendsRefreshing ? "Refreshing…" : "Refresh ↻"}
              </span>
            </h2>
            <div style={{ marginTop: 12 }}>
              {trendsLoading && trendItems.length === 0 ? (
                <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", padding: "9px 0" }}>
                  Loading trends…
                </div>
              ) : trendItems.length === 0 ? (
                <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", padding: "9px 0" }}>
                  No trends available right now.
                </div>
              ) : (
                trendItems.map((item) => (
                  <div
                    className="hl artlink"
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openInApp(item.url, item.title)}
                    onKeyDown={(e) => e.key === "Enter" && openInApp(item.url, item.title)}
                  >
                    <div className="cat">{item.source.split(" ")[0].slice(0, 8).toUpperCase()}</div>
                    <div>
                      <div className="ht">{item.title}</div>
                      <div className="hs">{item.source.toUpperCase()} · {relAge(item.date)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
