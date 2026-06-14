"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// ── Types ─────────────────────────────────────────────────────────────────────

type ArtWork = {
  id: string;
  source: string;
  title: string;
  artist: string;
  artistTitle?: string;
  year: string;
  genre: string;
  medium?: string;
  department?: string;
  origin?: string;
  imageUrl: string;
  thumbUrl: string;
  metUrl?: string;
  aicUrl?: string;
  wikiUrl?: string;
  isPublicDomain?: boolean;
};

type Poem = {
  title: string;
  author: string;
  lines: string[];
  linecount?: string;
  pinned?: boolean;
};

type ReadingItem = {
  id: string;
  source: string;
  title: string;
  author: string;
  subjects?: string[];
  readUrl?: string;
  coverUrl?: string;
  downloadCount?: number;
  year?: number | null;
  olUrl?: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const GENRE_FILTERS = [
  "All",
  // African diaspora & contemporary Black art
  "Harlem Renaissance", "African American Art", "Afrofuturism",
  // Western movements
  "Expressionism", "Impressionism", "Abstract", "Surrealism",
  "Cubism", "Post-Impressionism", "Romanticism", "Baroque", "Renaissance",
  "Modern", "Minimalism", "Figurative", "Pop Art",
  // Sculpture & decorative
  "Sculpture",
  // Global traditions
  "Asian Art", "Islamic Art",
  // Photo & design
  "Photography", "Art Deco",
];

type ArtSource = "aic" | "met" | "cma";

const GENRE_TO_QUERY: Record<string, { source: ArtSource; q: string; artist?: boolean; allowNonPD?: boolean }> = {
  "Harlem Renaissance":    { source: "aic", q: "jacob lawrence harlem", allowNonPD: true },
  "African American Art":  { source: "aic", q: "archibald motley chicago", allowNonPD: true },
  "Afrofuturism":          { source: "aic", q: "kerry james marshall", allowNonPD: true },
  "Expressionism":         { source: "aic", q: "expressionism painting" },
  "Impressionism":         { source: "cma", q: "monet" },
  "Abstract":              { source: "aic", q: "abstract expressionism" },
  "Surrealism":            { source: "aic", q: "surrealism painting" },
  "Cubism":                { source: "aic", q: "cubism picasso" },
  "Post-Impressionism":    { source: "cma", q: "van gogh" },
  "Romanticism":           { source: "cma", q: "turner" },
  "Baroque":               { source: "cma", q: "rembrandt" },
  "Renaissance":           { source: "cma", q: "raphael" },
  "Modern":                { source: "aic", q: "modern art" },
  "Minimalism":            { source: "aic", q: "minimalism art" },
  "Figurative":            { source: "aic", q: "figurative painting portrait" },
  "Pop Art":               { source: "aic", q: "pop art warhol" },
  "Sculpture":             { source: "cma", q: "rodin" },
  "Asian Art":             { source: "cma", q: "japanese woodblock" },
  "Islamic Art":           { source: "cma", q: "persian" },
  "Photography":           { source: "cma", q: "alfred stieglitz" },
  "Art Deco":              { source: "aic", q: "art deco design illustration" },
};

const AIC_CYCLE_QUERIES = [
  "expressionism painting",
  "impressionism monet",
  "abstract expressionism",
  "surrealism painting",
  "cubism picasso",
  "post impressionism cezanne",
  "romanticism delacroix",
  "minimalism art",
  "pop art warhol",
  "rodin sculpture",
  "figurative painting portrait",
  "seurat pointillism",
  "van gogh post impressionism",
  "color field painting",
  "caspar david friedrich",
  "rococo fragonard",
  "baroque painting caravaggio",
  "renaissance italian painting",
  "art deco design illustration",
  "japanese woodblock print",
  "photography documentary",
  "african american art chicago",
  "kerry james marshall",
];

const MET_CYCLE_QUERIES = [
  "Jacob Lawrence",
  "Aaron Douglas",
  "Romare Bearden",
  "Harlem Renaissance",
  "african american art twentieth century",
  "contemporary African art",
  "islamic geometric art",
  "Japanese painting Edo",
];

// Reading categories
const READING_CATEGORIES = [
  { id: "art-criticism",    label: "Art Criticism",    source: "reading",    topic: "art criticism",        mode: "gutenberg"  },
  { id: "art-history",      label: "Art History",      source: "reading",    topic: "art history",          mode: "gutenberg"  },
  { id: "architecture",     label: "Architecture",     source: "articles",   topic: "architectural_theory", mode: "openlibrary"},
  { id: "cultural-theory",  label: "Cultural Theory",  source: "articles",   topic: "cultural_theory",      mode: "openlibrary"},
  { id: "art-philosophy",   label: "Art Philosophy",   source: "articles",   topic: "aesthetics",           mode: "openlibrary"},
] as const;

type ReadingCategoryId = typeof READING_CATEGORIES[number]["id"];

// Poet context notes keyed by author fragment
const POET_CONTEXT: Record<string, string> = {
  "Blake":      "William Blake (1757–1827) was a Romantic poet and visionary artist whose mystical symbolism challenged Enlightenment rationalism. His illuminated books fused poetry and visual art into prophetic works that would influence generations.",
  "Whitman":    "Walt Whitman (1819–1892) broke every convention of 19th-century verse with expansive free lines and democratic vision. 'Leaves of Grass' catalogued American life with an intimacy unprecedented in English poetry.",
  "Dickinson":  "Emily Dickinson (1830–1886) wrote in near-total seclusion, producing nearly 1,800 poems of compressed intensity. Her slant rhymes and unconventional dashes created a private poetic language of startling modernity.",
  "Hughes":     "Langston Hughes (1902–1967) was the central voice of the Harlem Renaissance — blending jazz rhythms, blues cadences, and vernacular speech into poetry that celebrated Black American life with uncompromising beauty.",
  "Brooks":     "Gwendolyn Brooks (1917–2000) became the first African American to win the Pulitzer Prize (1950). Her poetry navigated race, gender, and urban life in Chicago with formal precision and devastating clarity.",
  "Eliot":      "T.S. Eliot (1888–1965) reshaped Modernist poetry with the fragmented mythological panoramas of 'The Waste Land'. His emphasis on tradition, allusion, and difficulty defined high Modernism's aesthetic.",
  "Stevens":    "Wallace Stevens (1879–1955) was a philosopher of imagination — his lush, difficult poetry explored how the mind creates meaning in a world stripped of religious certainty. 'The Supreme Fiction' is his central project.",
  "Neruda":     "Pablo Neruda (1904–1973) wrote with volcanic sensuality and political fire. His 'Twenty Love Poems' are among the most-read poems in any language; his later work turned to elemental matter and democratic solidarity.",
  "Rilke":      "Rainer Maria Rilke (1875–1926) sought the transcendent in physical beauty and mortality. His 'Duino Elegies' and 'Sonnets to Orpheus' stand as the supreme achievement of German lyric modernism.",
  "Baraka":     "Amiri Baraka (1934–2014) was the incendiary voice of the Black Arts Movement — merging jazz aesthetics, Marxist politics, and African American vernacular into poetry that demanded social transformation.",
};

function getPoetContext(author: string): string {
  for (const [key, note] of Object.entries(POET_CONTEXT)) {
    if (author.toLowerCase().includes(key.toLowerCase())) return note;
  }
  return "A poet whose work spans tradition and transformation, bringing formal mastery to urgent human experience.";
}

// ── Artist context companion paragraph ───────────────────────────────────────

function buildArtistContext(work: ArtWork): string {
  const artist = work.artistTitle || work.artist.split("\n")[0];
  const year   = work.year || "an unknown date";
  const medium = work.medium || "mixed media";
  const dept   = work.department || "the permanent collection";
  const genre  = work.genre || "Fine Art";

  const genreNote: Record<string, string> = {
    "Expressionism":       "Created during a period when artists prioritized emotional truth over literal representation,",
    "Impressionism":       "Painted with loose brushwork that captured fleeting light and atmospheric sensation,",
    "Abstract":            "Working outside figuration, the artist reduced form to its essential elements —",
    "Surrealism":          "Drawing from the unconscious mind and dreamlike imagery,",
    "Cubism":              "Fracturing conventional perspective to show multiple viewpoints simultaneously,",
    "Post-Impressionism":  "Moving beyond Impressionism toward more structured or symbolic approaches,",
    "Romanticism":         "Suffused with emotional intensity and a reverence for nature and the sublime,",
    "Minimalism":          "Stripped to geometric essence, the work foregrounds material and space over narrative —",
    "Harlem Renaissance":  "Emerging from the cultural flowering of Black American art in the early 20th century,",
    "Figurative":          "Rooted in the human form, the work explores identity, presence, and lived experience —",
    "Sculpture":           "Working in three dimensions, the artist transformed material into form —",
    "Pop Art":             "Drawing from commercial culture and everyday imagery,",
  };

  const note = genreNote[genre] ?? "A work of singular vision,";

  return `${note} this ${medium.toLowerCase()} piece by ${artist} dates to ${year}. It belongs to ${dept}. The work invites sustained attention — not simply as historical document, but as a living aesthetic object whose meaning shifts with each encounter.`;
}

// ── Supabase sync helpers ─────────────────────────────────────────────────────

const supabase = typeof window !== "undefined" ? createClient() : null;

async function loadSupabasePins(
  type: "art" | "poem" | "reading",
): Promise<string[]> {
  if (!supabase) return [];
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    const { data, error } = await supabase
      .from("gallery_favorites")
      .select("item_id")
      .eq("user_id", user.id)
      .eq("item_type", type);
    if (error) return [];
    return (data ?? []).map((r: { item_id: string }) => r.item_id);
  } catch {
    return [];
  }
}

async function upsertSupabasePin(
  type: "art" | "poem" | "reading",
  itemId: string,
  metadata: Record<string, unknown>,
  remove: boolean,
): Promise<void> {
  if (!supabase) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    if (remove) {
      await supabase
        .from("gallery_favorites")
        .delete()
        .eq("user_id", user.id)
        .eq("item_type", type)
        .eq("item_id", itemId);
    } else {
      await supabase.from("gallery_favorites").upsert(
        { user_id: user.id, item_type: type, item_id: itemId, metadata },
        { onConflict: "user_id,item_type,item_id" },
      );
    }
  } catch {
    // Table may not exist yet — silent no-op
  }
}

// ── Pin state factory ─────────────────────────────────────────────────────────

function loadLocalPins(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveLocalPins(key: string, pins: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...pins])); } catch {}
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useArtGallery(query: string, source: ArtSource, artistSearch = false, allowNonPD = false) {
  const [works, setWorks] = useState<ArtWork[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const params = `/api/gallery?source=${source}&q=${encodeURIComponent(query)}${artistSearch ? "&artistSearch=1" : ""}${allowNonPD ? "&allowNonPD=1" : ""}`;
    setLoading(true);
    fetch(params, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d: { works?: ArtWork[] }) => {
        if (!ctrl.signal.aborted) {
          setWorks((d.works ?? []).filter((w) => w.thumbUrl || w.imageUrl));
        }
      })
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });

    return () => ctrl.abort();
  }, [query, source]);

  return { works, loading };
}

function usePoetry() {
  const [poems, setPoems] = useState<Poem[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/gallery?source=poems")
      .then((r) => r.json())
      .then((d: { poems?: Poem[] }) => {
        if (d.poems?.length) { setPoems(d.poems); setIdx(0); }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const next = useCallback(() => setIdx((i) => (i + 1) % Math.max(poems.length, 1)), [poems.length]);
  const prev = useCallback(() => setIdx((i) => (i - 1 + Math.max(poems.length, 1)) % Math.max(poems.length, 1)), [poems.length]);

  return { poem: poems[idx] ?? null, idx, total: poems.length, next, prev, load, loading };
}

function useReading(categoryId: ReadingCategoryId) {
  const [books, setBooks] = useState<ReadingItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const cat = READING_CATEGORIES.find((c) => c.id === categoryId);
    if (!cat) return;

    setLoading(true);
    const url = cat.mode === "openlibrary"
      ? `/api/gallery?source=articles&subject=${encodeURIComponent(cat.topic)}`
      : `/api/gallery?source=reading&topic=${encodeURIComponent(cat.topic)}`;

    fetch(url)
      .then((r) => r.json())
      .then((d: { books?: ReadingItem[] }) => setBooks(d.books ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [categoryId]);

  return { books, loading };
}

// ── Art card ──────────────────────────────────────────────────────────────────

function ArtCard({
  work, pinned, onPin, onOpen,
}: {
  work: ArtWork; pinned: boolean; onPin: () => void; onOpen: () => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) setImgLoaded(true);
  }, []);

  return (
    <div
      className="g-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      style={{ borderRadius: 2, border: "1px solid var(--line-strong)", overflow: "hidden", cursor: "pointer" }}
    >
      <div className="g-img-wrap" style={{ position: "relative", display: "block" }}>
        {!imgLoaded && !imgErr && <div className="g-img-placeholder" />}
        {!imgErr && (
          <img
            ref={imgRef}
            src={work.thumbUrl || work.imageUrl}
            alt={work.title}
            className="g-img"
            style={{ opacity: imgLoaded ? 1 : 0, display: "block", width: "100%", objectFit: "cover" }}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgErr(true)}
            loading="lazy"
          />
        )}
        {imgErr && (
          <div className="g-img-err">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 28, height: 28, opacity: 0.25 }}>
              <rect x="3" y="4" width="18" height="16" rx="0" />
              <path d="M3 15l5-5 4 4 3-3 6 6" />
            </svg>
          </div>
        )}
        <button
          type="button"
          className={`g-pin${pinned ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={pinned ? "Unpin" : "Pin"}
          style={{
            position: "absolute", top: 8, right: 8,
            background: "rgba(10,11,14,0.72)", border: "1px solid var(--line-strong)",
            color: pinned ? "var(--accent)" : "var(--ink-faint)",
            width: 28, height: 28, borderRadius: 2,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, cursor: "pointer", backdropFilter: "blur(4px)",
          }}
        >
          {pinned ? "★" : "☆"}
        </button>
        {work.source !== "canon" && (
          <div
            className="g-source-badge"
            style={{
              position: "absolute", bottom: 8, left: 8,
              fontFamily: "var(--mono)", fontSize: 8, letterSpacing: "0.12em",
              background: "rgba(10,11,14,0.8)", color: "var(--ink-faint)",
              padding: "2px 6px", border: "1px solid var(--line)",
            }}
          >
            {work.source.toUpperCase()}
          </div>
        )}
      </div>
      <div
        className="g-meta"
        style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--line-strong)", background: "var(--surface)" }}
      >
        <div
          className="g-title"
          style={{ fontFamily: "var(--narrow)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink)", lineHeight: 1.3, marginBottom: 3 }}
        >
          {work.title}
        </div>
        <div
          className="g-artist"
          style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", lineHeight: 1.2 }}
        >
          {(work.artistTitle || work.artist.split("\n")[0]).slice(0, 40)}
        </div>
        <div
          className="g-genre"
          style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", marginTop: 3, opacity: 0.7 }}
        >
          {work.year && <span>{work.year}</span>}
          {work.year && work.genre && <span style={{ margin: "0 4px" }}>·</span>}
          {work.genre && <span>{work.genre}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Art detail overlay ────────────────────────────────────────────────────────

function ArtDetail({
  work, pinned, onPin, onClose,
}: {
  work: ArtWork; pinned: boolean; onPin: () => void; onClose: () => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  const context = buildArtistContext(work);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="g-detail-overlay"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(10,11,14,0.92)", backdropFilter: "blur(8px)",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* Always-visible navigation bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 24px", flexShrink: 0,
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "var(--surface-2)", border: "1px solid var(--line-strong)",
            color: "var(--ink)", padding: "6px 14px", borderRadius: 2,
            fontFamily: "var(--narrow)", fontSize: 12, fontWeight: 600,
            letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 12, height: 12 }}>
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back to Gallery
        </button>
        <div style={{ fontFamily: "var(--narrow)", fontSize: 12, color: "var(--ink-dim)", letterSpacing: "0.06em", textTransform: "uppercase", maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {work.title}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "var(--surface-2)", border: "1px solid var(--line-strong)",
            color: "var(--ink-dim)", width: 32, height: 32, borderRadius: 2,
            fontFamily: "var(--mono)", fontSize: 14, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >✕</button>
      </div>

      {/* Scrollable content area */}
      <div
        style={{
          flex: 1, overflow: "auto", display: "flex",
          alignItems: "flex-start", justifyContent: "center",
          padding: "24px 24px 40px",
        }}
        onClick={onClose}
      >
        <div
          className="g-detail"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: "var(--surface)", border: "1px solid var(--line-strong)",
            borderRadius: 2, maxWidth: 900, width: "100%",
          }}
        >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 0 }}>
          {/* Image */}
          <div style={{ background: "#0a0b0e", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
            {!imgErr ? (
              <img
                src={work.imageUrl || work.thumbUrl}
                alt={work.title}
                onError={() => setImgErr(true)}
                style={{ display: "block", maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }}
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", minHeight: 280 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 48, height: 48, opacity: 0.15 }}>
                  <rect x="3" y="4" width="18" height="16" rx="0" />
                  <path d="M3 15l5-5 4 4 3-3 6 6" />
                </svg>
              </div>
            )}
          </div>

          {/* Metadata panel */}
          <div style={{ padding: "32px 28px 28px", borderLeft: "1px solid var(--line-strong)", display: "flex", flexDirection: "column", gap: 0 }}>
            {work.genre && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.14em", color: "var(--accent)", textTransform: "uppercase", marginBottom: 10 }}>
                {work.genre}
              </div>
            )}
            <h2 style={{ fontFamily: "var(--narrow)", fontSize: 20, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--ink)", lineHeight: 1.2, marginBottom: 10 }}>
              {work.title}
            </h2>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)", marginBottom: 4 }}>
              {(work.artistTitle || work.artist.split("\n")[0])}
            </div>
            {work.year && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", marginBottom: 16 }}>
                {work.year}
              </div>
            )}

            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {work.medium && (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.1em", paddingTop: 1 }}>Medium</span>
                  <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-dim)", textAlign: "right", flex: 1 }}>{work.medium}</span>
                </div>
              )}
              {work.department && (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.1em", paddingTop: 1 }}>Collection</span>
                  <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-dim)", textAlign: "right", flex: 1 }}>{work.department}</span>
                </div>
              )}
              {work.origin && (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.1em", paddingTop: 1 }}>Origin</span>
                  <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-dim)", textAlign: "right", flex: 1 }}>{work.origin}</span>
                </div>
              )}
            </div>

            {/* Artist Context */}
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, marginTop: 8 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--ink-faint)", textTransform: "uppercase", marginBottom: 8 }}>
                Artist Context
              </div>
              <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.65, margin: 0 }}>
                {context}
              </p>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, marginTop: "auto", paddingTop: 20, flexWrap: "wrap" }}>
              <button
                type="button"
                className={`savebtn${pinned ? " active" : ""}`}
                onClick={onPin}
                style={pinned ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}
              >
                {pinned ? "★ Pinned" : "☆ Pin"}
              </button>
              {(work.aicUrl || work.metUrl) && (
                <a
                  href={work.aicUrl || work.metUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="savebtn"
                >
                  View source ↗
                </a>
              )}
            </div>

            {work.isPublicDomain && (
              <p style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink-faint)", marginTop: 12 }}>
                PUBLIC DOMAIN · FREE TO USE
              </p>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

// ── Poetry panel ──────────────────────────────────────────────────────────────

function PoetryPanel({
  pinnedPoems,
  onTogglePoemPin,
}: {
  pinnedPoems: Set<string>;
  onTogglePoemPin: (key: string, poem: Poem) => void;
}) {
  const { poem, idx, total, next, prev, load, loading } = usePoetry();
  const [contextOpen, setContextOpen] = useState(false);

  const poemKey = poem ? `${poem.author}::${poem.title}` : "";
  const isPinned = pinnedPoems.has(poemKey);

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      {loading && (
        <div className="empty-state" style={{ padding: "60px 0" }}>
          Loading curated poems…
        </div>
      )}

      {!loading && !poem && (
        <div className="empty-state" style={{ padding: "60px 0" }}>
          No poems loaded.
          <button type="button" className="savebtn" onClick={load} style={{ marginLeft: 12 }}>
            Load poems
          </button>
        </div>
      )}

      {!loading && poem && (
        <div style={{ padding: "36px 0 32px", maxWidth: 680 }}>
          {/* Poet overline */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, letterSpacing: "0.22em", color: "var(--gold)", textTransform: "uppercase", flexShrink: 0, opacity: 0.8 }}>
              {poem.author}
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          {/* Poem title */}
          <h2 style={{
            fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
            fontSize: 26, color: "var(--ink-dim)", lineHeight: 1.2, marginBottom: 28,
            letterSpacing: "-0.01em",
          }}>
            {poem.title}.
          </h2>

          {/* Lines */}
          <div style={{ borderLeft: "1px solid var(--accent)", paddingLeft: 22, marginBottom: 34 }}>
            {poem.lines.map((line, i) => (
              <div
                key={i}
                style={{
                  fontFamily: "var(--serif)", fontSize: 14.5, lineHeight: 1.9,
                  color: line.trim() === "" ? "transparent" : "var(--ink-faint)",
                  minHeight: line.trim() === "" ? "0.8em" : undefined,
                  userSelect: "text", fontWeight: 300, letterSpacing: "0.01em",
                }}
              >
                {line || " "}
              </div>
            ))}
          </div>

          {/* Context accordion */}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 18, marginBottom: 28 }}>
            <button
              type="button"
              onClick={() => setContextOpen((v) => !v)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.14em",
                color: "var(--ink-faint)", textTransform: "uppercase",
                background: "none", border: "none", cursor: "pointer", padding: 0,
              }}
            >
              <span style={{ fontSize: 8, opacity: 0.7 }}>{contextOpen ? "▾" : "▸"}</span>
              Poet Context
            </button>
            {contextOpen && (
              <p style={{
                fontFamily: "var(--serif)", fontStyle: "italic",
                fontSize: 13.5, color: "var(--ink-dim)", lineHeight: 1.8,
                marginTop: 14, marginBottom: 0, fontWeight: 300,
                borderLeft: "1px solid var(--line)", paddingLeft: 16,
              }}>
                {getPoetContext(poem.author)}
              </p>
            )}
          </div>

          {/* Navigation + actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              onClick={prev}
              style={{
                fontFamily: "var(--mono)", fontSize: 14, background: "none",
                border: "1px solid var(--line-strong)", color: "var(--ink-dim)",
                width: 34, height: 34, borderRadius: 3, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >←</button>

            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", letterSpacing: "0.12em" }}>
              {idx + 1} / {total}
            </span>

            <button
              type="button"
              onClick={next}
              style={{
                fontFamily: "var(--mono)", fontSize: 14, background: "none",
                border: "1px solid var(--line-strong)", color: "var(--ink-dim)",
                width: 34, height: 34, borderRadius: 3, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >→</button>

            <button
              type="button"
              className={`savebtn${isPinned ? " active" : ""}`}
              onClick={() => onTogglePoemPin(poemKey, poem)}
              style={isPinned ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}
            >
              {isPinned ? "★ Favorite" : "☆ Favorite"}
            </button>

            <button
              type="button"
              className="savebtn"
              onClick={load}
              style={{ marginLeft: "auto" }}
              disabled={loading}
            >
              ↻ More
            </button>
          </div>
        </div>
      )}

      <p style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--ink-faint)", marginTop: 28, textAlign: "center", letterSpacing: "0.12em" }}>
        SOURCED FROM POETRYDB · PUBLIC DOMAIN POETRY
      </p>
    </div>
  );
}

// ── Reading card ──────────────────────────────────────────────────────────────

function ReadingCard({
  book, pinned, onPin,
}: {
  book: ReadingItem; pinned: boolean; onPin: () => void;
}) {
  const [imgErr, setImgErr] = useState(false);

  return (
    <div
      className="g-book-card"
      style={{
        display: "flex", gap: 12, padding: 12,
        border: "1px solid var(--line-strong)", borderRadius: 2,
        background: "var(--surface)", position: "relative",
        transition: "border-color 0.15s",
      }}
    >
      {/* Cover */}
      {book.coverUrl && !imgErr ? (
        <img
          src={book.coverUrl}
          alt={book.title}
          onError={() => setImgErr(true)}
          style={{ width: 56, height: 80, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line)" }}
          loading="lazy"
        />
      ) : (
        <div style={{
          width: 56, height: 80, flexShrink: 0, background: "var(--surface-2)",
          border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ width: 20, height: 20, opacity: 0.2 }}>
            <rect x="4" y="2" width="16" height="20" rx="0" />
            <path d="M9 7h6M9 11h6M9 15h4" />
          </svg>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <a
          href={book.readUrl || book.olUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontFamily: "var(--narrow)", fontSize: 13, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: "0.03em",
            color: "var(--ink)", textDecoration: "none", lineHeight: 1.25,
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
          }}
        >
          {book.title}
        </a>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)" }}>
          {book.author}
        </div>
        {book.year && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)" }}>
            {book.year}
          </div>
        )}
        {book.subjects && book.subjects.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            {book.subjects.slice(0, 3).map((s) => (
              <span
                key={s}
                className="chip"
                style={{ fontSize: 8, padding: "1px 5px" }}
              >
                {s.replace(/_/g, " ").toUpperCase()}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Pin button */}
      <button
        type="button"
        onClick={onPin}
        title={pinned ? "Unfavorite" : "Favorite"}
        style={{
          alignSelf: "flex-start", flexShrink: 0,
          background: "none", border: "none", cursor: "pointer",
          color: pinned ? "var(--accent)" : "var(--ink-faint)",
          fontSize: 15, lineHeight: 1, padding: 2,
        }}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}

// ── Reading tab ───────────────────────────────────────────────────────────────

function ReadingTab({
  pinnedReadings,
  onToggleReadingPin,
}: {
  pinnedReadings: Set<string>;
  onToggleReadingPin: (id: string, book: ReadingItem) => void;
}) {
  const [categoryId, setCategoryId] = useState<ReadingCategoryId>("art-criticism");
  const [showFavs, setShowFavs] = useState(false);
  const { books, loading } = useReading(categoryId);

  const displayed = showFavs
    ? books.filter((b) => pinnedReadings.has(b.id))
    : books;

  return (
    <>
      {/* Category bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div className="chips" style={{ marginBottom: 0, flex: 1 }}>
          {READING_CATEGORIES.map((cat) => (
            <span
              key={cat.id}
              className={categoryId === cat.id ? "chip on" : "chip"}
              onClick={() => { setCategoryId(cat.id); setShowFavs(false); }}
              style={{ cursor: "pointer" }}
            >
              {cat.label}
            </span>
          ))}
        </div>
        <button
          type="button"
          className={`savebtn${showFavs ? " active" : ""}`}
          onClick={() => setShowFavs((v) => !v)}
          style={showFavs ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}
        >
          ★ {pinnedReadings.size > 0 ? `${pinnedReadings.size} saved` : "Saved"}
        </button>
      </div>

      {loading ? (
        <div className="empty-state">Searching library…</div>
      ) : displayed.length === 0 ? (
        <div className="empty-state">
          {showFavs ? "No saved readings yet — star a book to save it." : "No books found."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
          {displayed.map((b) => (
            <ReadingCard
              key={b.id}
              book={b}
              pinned={pinnedReadings.has(b.id)}
              onPin={() => onToggleReadingPin(b.id, b)}
            />
          ))}
        </div>
      )}

      <p style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink-faint)", marginTop: 24, letterSpacing: "0.1em" }}>
        PROJECT GUTENBERG · OPEN LIBRARY · ALL WORKS OPEN-ACCESS
      </p>
    </>
  );
}

// ── Main module ───────────────────────────────────────────────────────────────

export function GalleryModule() {
  const [tab, setTab]             = useState<"art" | "poetry" | "reading">("art");
  const [genre, setGenre]         = useState("All");
  const [showPinsOnly, setShowPinsOnly] = useState(false);

  // Art query cycling
  const aicRef = useRef(0);
  const metRef = useRef(0);
  const [artSource, setArtSource]         = useState<ArtSource>("aic");
  const [artQuery, setArtQuery]           = useState(AIC_CYCLE_QUERIES[0]);
  const [artArtistSearch, setArtArtist]   = useState(false);
  const [artAllowNonPD, setArtNonPD]      = useState(false);
  const [artistInput, setArtistInput]     = useState("");

  // Detail overlay
  const [detail, setDetail] = useState<ArtWork | null>(null);

  // ── Pin state ────────────────────────────────────────────────────────────

  const [pinnedArt, setPinnedArt] = useState<Set<string>>(() => new Set());
  const [pinnedPoems, setPinnedPoems] = useState<Set<string>>(() => new Set());
  const [pinnedReadings, setPinnedReadings] = useState<Set<string>>(() => new Set());

  // Load Supabase pins on mount and merge
  useEffect(() => {
    (async () => {
      const [artPins, poemPins, readingPins] = await Promise.all([
        loadSupabasePins("art"),
        loadSupabasePins("poem"),
        loadSupabasePins("reading"),
      ]);
      // Merge Supabase pins with any already-loaded local pins
      if (artPins.length)     setPinnedArt((p)     => new Set([...p, ...artPins]));
      if (poemPins.length)    setPinnedPoems((p)    => new Set([...p, ...poemPins]));
      if (readingPins.length) setPinnedReadings((p) => new Set([...p, ...readingPins]));
    })();
    // Load local pins after hydration (avoids SSR mismatch)
    setPinnedArt((p) => new Set([...p, ...loadLocalPins("axis-gallery-art-pins")]));
    setPinnedPoems((p) => new Set([...p, ...loadLocalPins("axis-gallery-poem-pins")]));
    setPinnedReadings((p) => new Set([...p, ...loadLocalPins("axis-gallery-reading-pins")]));
  }, []);

  // ── Toggle helpers ───────────────────────────────────────────────────────

  const toggleArtPin = useCallback((id: string, work?: ArtWork) => {
    setPinnedArt((prev) => {
      const next = new Set(prev);
      const remove = next.has(id);
      if (remove) next.delete(id); else next.add(id);
      saveLocalPins("axis-gallery-art-pins", next);
      upsertSupabasePin("art", id, work ? { title: work.title, artist: work.artist } : {}, remove);
      return next;
    });
  }, []);

  const togglePoemPin = useCallback((key: string, poem: Poem) => {
    setPinnedPoems((prev) => {
      const next = new Set(prev);
      const remove = next.has(key);
      if (remove) next.delete(key); else next.add(key);
      saveLocalPins("axis-gallery-poem-pins", next);
      upsertSupabasePin("poem", key, { title: poem.title, author: poem.author }, remove);
      return next;
    });
  }, []);

  const toggleReadingPin = useCallback((id: string, book: ReadingItem) => {
    setPinnedReadings((prev) => {
      const next = new Set(prev);
      const remove = next.has(id);
      if (remove) next.delete(id); else next.add(id);
      saveLocalPins("axis-gallery-reading-pins", next);
      upsertSupabasePin("reading", id, { title: book.title, author: book.author }, remove);
      return next;
    });
  }, []);

  // ── Art cycling ──────────────────────────────────────────────────────────

  const cycleArt = () => {
    // Rotate AIC (3) → CMA (1) → MET (1) pattern for variety
    const mod = aicRef.current % 5;
    if (mod === 3) {
      setArtSource("met");
      metRef.current = (metRef.current + 1) % MET_CYCLE_QUERIES.length;
      setArtQuery(MET_CYCLE_QUERIES[metRef.current]);
    } else if (mod === 4) {
      setArtSource("cma");
      setArtQuery(["monet", "van gogh", "rembrandt", "japanese woodblock", "alfred stieglitz"][Math.floor(Math.random() * 5)]);
    } else {
      setArtSource("aic");
      aicRef.current = (aicRef.current + 1) % AIC_CYCLE_QUERIES.length;
      setArtQuery(AIC_CYCLE_QUERIES[aicRef.current]);
    }
    aicRef.current++;
  };

  // ── Art data ─────────────────────────────────────────────────────────────

  const { works, loading: artLoading } = useArtGallery(artQuery, artSource, artArtistSearch, artAllowNonPD);

  // Each genre filter drives its own genre-specific API fetch, so the returned
  // works already belong to the selected genre — no need to re-filter by genre
  // here (doing so causes mismatches when deriveGenre maps query → different name).
  const filtered = useMemo(() => {
    if (showPinsOnly) return works.filter((w) => pinnedArt.has(w.id));
    return works;
  }, [works, showPinsOnly, pinnedArt]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Header */}
      <div className="divider" />

      {/* Tab bar */}
      <div className="subtabbar" style={{ marginBottom: 24 }}>
        {(["art", "poetry", "reading"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`subtab${tab === t ? " on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "art" ? "ART" : t === "poetry" ? "POETRY" : "READING"}
          </button>
        ))}
      </div>

      {/* ── ART TAB ────────────────────────────────────────────────────────── */}
      {tab === "art" && (
        <>
          {/* Artist search */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const q = artistInput.trim();
              if (!q) return;
              setGenre("All");
              setArtSource("aic");
              setArtArtist(false);
              setArtNonPD(true);
              setArtQuery(q);
            }}
            style={{ display: "flex", gap: 8, marginBottom: 14 }}
          >
            <input
              type="text"
              value={artistInput}
              onChange={(e) => setArtistInput(e.target.value)}
              placeholder="Search by artist or title…"
              style={{
                flex: 1, background: "var(--surface-2)", border: "1px solid var(--line)",
                borderRadius: 4, padding: "7px 12px", fontSize: 12, color: "var(--ink)",
                fontFamily: "var(--mono)", outline: "none",
              }}
            />
            <button type="submit" className="savebtn">Search</button>
          </form>

          {/* Toolbar */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div className="chips" style={{ marginBottom: 0, flex: 1, minWidth: 0 }}>
              {GENRE_FILTERS.map((g) => (
                <span
                  key={g}
                  className={genre === g ? "chip on" : "chip"}
                  onClick={() => {
                    setGenre(g);
                    if (g === "All") {
                      setArtSource("aic");
                      setArtArtist(false);
                      setArtNonPD(false);
                      setArtQuery(AIC_CYCLE_QUERIES[aicRef.current % AIC_CYCLE_QUERIES.length]);
                    } else {
                      const target = GENRE_TO_QUERY[g];
                      if (target) {
                        setArtSource(target.source);
                        setArtArtist(target.artist ?? false);
                        setArtNonPD(target.allowNonPD ?? false);
                        setArtQuery(target.q);
                      }
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {g}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                className={`savebtn${showPinsOnly ? " active" : ""}`}
                onClick={() => setShowPinsOnly((v) => !v)}
                style={showPinsOnly ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}}
              >
                ★ {pinnedArt.size > 0 ? `${pinnedArt.size}` : "Favorites"}
              </button>
              <button
                type="button"
                className="savebtn"
                onClick={cycleArt}
                disabled={artLoading}
              >
                {artLoading ? "Loading…" : "↻ Discover"}
              </button>
            </div>
          </div>

          {/* Grid */}
          {artLoading ? (
            <div className="empty-state" style={{ padding: "60px 0" }}>
              Fetching artworks…
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state" style={{ padding: "48px 0" }}>
              {showPinsOnly
                ? "No pinned works yet — click ☆ on any artwork to pin it."
                : "No works match this filter."}
            </div>
          ) : (
            <div
              className="g-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: 16,
              }}
            >
              {filtered.map((work) => (
                <div key={work.id} style={{ breakInside: "avoid", marginBottom: 16 }}>
                  <ArtCard
                    work={work}
                    pinned={pinnedArt.has(work.id)}
                    onPin={() => toggleArtPin(work.id, work)}
                    onOpen={() => setDetail(work)}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── POETRY TAB ──────────────────────────────────────────────────────── */}
      {tab === "poetry" && (
        <PoetryPanel
          pinnedPoems={pinnedPoems}
          onTogglePoemPin={togglePoemPin}
        />
      )}

      {/* ── READING TAB ─────────────────────────────────────────────────────── */}
      {tab === "reading" && (
        <ReadingTab
          pinnedReadings={pinnedReadings}
          onToggleReadingPin={toggleReadingPin}
        />
      )}

      {/* Art detail overlay */}
      {detail && (
        <ArtDetail
          work={detail}
          pinned={pinnedArt.has(detail.id)}
          onPin={() => toggleArtPin(detail.id, detail)}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}
