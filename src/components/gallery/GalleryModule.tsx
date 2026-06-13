"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ArtWork = {
  id: string;
  source: string;
  title: string;
  artist: string;
  year: string;
  genre: string;
  medium?: string;
  department?: string;
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

// ── Canon seed images (from /public/art/) ────────────────────────────────────

const CANON: ArtWork[] = [
  {
    id: "canon-01", source: "canon",
    title: "Blue Face on Orange", artist: "Basquiat / Nkoth", year: "2020s",
    genre: "Neo-Expressionism",
    medium: "Mixed media",
    imageUrl: "/art/01_basquiat-nkoth_blue-face-on-orange.png",
    thumbUrl: "/art/01_basquiat-nkoth_blue-face-on-orange.png",
  },
  {
    id: "canon-02", source: "canon",
    title: "Molten Gold", artist: "Afrofuturism", year: "2020s",
    genre: "Afrofuturism",
    medium: "Digital",
    imageUrl: "/art/02_afrofuturism_molten-gold-cover.png",
    thumbUrl: "/art/02_afrofuturism_molten-gold-cover.png",
  },
  {
    id: "canon-03", source: "canon",
    title: "Graphite Profile", artist: "Toyin Ojih Odutola", year: "2010s",
    genre: "Figurative",
    medium: "Charcoal and graphite",
    imageUrl: "/art/03_ojih-odutola_graphite-profile.png",
    thumbUrl: "/art/03_ojih-odutola_graphite-profile.png",
  },
  {
    id: "canon-04", source: "canon",
    title: "Gold-Red Swirled Face", artist: "Ludovic Nkoth", year: "2020s",
    genre: "Neo-Expressionism",
    medium: "Oil on canvas",
    imageUrl: "/art/04_nkoth_gold-red-swirled-face.png",
    thumbUrl: "/art/04_nkoth_gold-red-swirled-face.png",
  },
  {
    id: "canon-05", source: "canon",
    title: "Blue Water Boat", artist: "Ludovic Nkoth", year: "2020s",
    genre: "Expressionism",
    medium: "Oil on canvas",
    imageUrl: "/art/05_nkoth_blue-water-boat.png",
    thumbUrl: "/art/05_nkoth_blue-water-boat.png",
  },
  {
    id: "canon-06", source: "canon",
    title: "Figure at Sunset", artist: "Ludovic Nkoth", year: "2020s",
    genre: "Figurative",
    medium: "Oil on canvas",
    imageUrl: "/art/06_nkoth_figure-sunset-sky.png",
    thumbUrl: "/art/06_nkoth_figure-sunset-sky.png",
  },
  {
    id: "canon-07", source: "canon",
    title: "Flat Ultramarine Market", artist: "Jacob Lawrence", year: "1940s",
    genre: "Harlem Renaissance",
    medium: "Gouache on board",
    imageUrl: "/art/07_lawrence_flat-ultramarine-market.png",
    thumbUrl: "/art/07_lawrence_flat-ultramarine-market.png",
  },
  {
    id: "canon-08", source: "canon",
    title: "Interior Collage I", artist: "Njideka Akunyili Crosby", year: "2010s",
    genre: "Contemporary",
    medium: "Collage, acrylic, and transfers",
    imageUrl: "/art/08_akunyili-crosby_interior-collage.png",
    thumbUrl: "/art/08_akunyili-crosby_interior-collage.png",
  },
  {
    id: "canon-09", source: "canon",
    title: "Collage Figures", artist: "Njideka Akunyili Crosby", year: "2010s",
    genre: "Contemporary",
    medium: "Collage and transfer",
    imageUrl: "/art/09_akunyili-crosby_collage-figures.png",
    thumbUrl: "/art/09_akunyili-crosby_collage-figures.png",
  },
];

const GENRES = [
  "All", "Neo-Expressionism", "Harlem Renaissance", "Afrofuturism", "Figurative",
  "Contemporary", "Expressionism", "Impressionism", "Abstract", "Surrealism",
  "Minimalism", "Cubism", "Pop Art", "Romanticism", "Modern",
];

const ART_QUERIES = [
  "African American art", "abstract expressionism", "Harlem Renaissance",
  "color field painting", "modern portrait", "geometric abstraction",
];

const READING_SUBJECTS = [
  { label: "Art History", key: "art_history" },
  { label: "Aesthetics", key: "aesthetics" },
  { label: "Modern Art", key: "modern_art" },
  { label: "African Art", key: "african_art" },
  { label: "Photography", key: "photography" },
];

const READING_TOPICS = [
  { label: "Art Criticism", key: "art criticism" },
  { label: "Color Theory", key: "color theory" },
  { label: "Expressionism", key: "expressionism" },
  { label: "Bauhaus", key: "bauhaus" },
  { label: "Aesthetics", key: "aesthetics" },
];

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useGalleryArt(query: string) {
  const [works, setWorks] = useState<ArtWork[]>(CANON);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const src = query.toLowerCase().includes("harlem") || query.toLowerCase().includes("african")
      ? "met" : "aic";
    fetch(`/api/gallery?source=${src}&q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((d: { works?: ArtWork[] }) => {
        const fetched = (d.works ?? []).filter((w) => w.thumbUrl || w.imageUrl);
        setWorks([...CANON, ...fetched]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [query]);

  return { works, loading };
}

function usePoetry() {
  const [poems, setPoems] = useState<Poem[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    fetch("/api/gallery?source=poetry&count=8")
      .then((r) => r.json())
      .then((d: { poems?: Poem[] }) => { if (d.poems?.length) setPoems(d.poems); })
      .catch(() => {});
  }, []);

  const next = useCallback(() => setIdx((i) => (i + 1) % Math.max(poems.length, 1)), [poems.length]);
  const prev = useCallback(() => setIdx((i) => (i - 1 + Math.max(poems.length, 1)) % Math.max(poems.length, 1)), [poems.length]);

  return { poem: poems[idx] ?? null, next, prev, count: poems.length };
}

function useReading(topic: string, mode: "gutenberg" | "openlibrary", subject?: string) {
  const [books, setBooks] = useState<ReadingItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const url = mode === "openlibrary"
      ? `/api/gallery?source=openlibrary&subject=${encodeURIComponent(subject ?? "art_history")}`
      : `/api/gallery?source=reading&topic=${encodeURIComponent(topic)}`;
    fetch(url)
      .then((r) => r.json())
      .then((d: { books?: ReadingItem[] }) => setBooks(d.books ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [topic, mode, subject]);

  return { books, loading };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ArtCard({
  work,
  pinned,
  onPin,
  onOpen,
}: {
  work: ArtWork;
  pinned: boolean;
  onPin: () => void;
  onOpen: () => void;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Images already in browser cache fire onLoad before React renders
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setImgLoaded(true);
    }
  }, []);

  return (
    <div className="g-card" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="g-img-wrap">
        {!imgLoaded && !imgErr && <div className="g-img-placeholder" />}
        {!imgErr && (
          <img
            ref={imgRef}
            src={work.thumbUrl || work.imageUrl}
            alt={work.title}
            className="g-img"
            style={{ opacity: imgLoaded ? 1 : 0 }}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgErr(true)}
            loading="lazy"
          />
        )}
        {imgErr && (
          <div className="g-img-err">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ width: 28, height: 28, opacity: 0.3 }}>
              <rect x="3" y="4" width="18" height="16" rx="1" />
              <path d="M3 15l5-5 4 4 3-3 6 6" />
            </svg>
          </div>
        )}
        <button
          type="button"
          className={`g-pin${pinned ? " on" : ""}`}
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          title={pinned ? "Unpin" : "Pin"}
        >
          {pinned ? "★" : "☆"}
        </button>
        {work.source !== "canon" && (
          <div className="g-source-badge">{work.source.toUpperCase()}</div>
        )}
      </div>
      <div className="g-meta">
        <div className="g-title">{work.title}</div>
        <div className="g-artist">{work.artist}{work.year ? ` · ${work.year}` : ""}</div>
        <div className="g-genre">{work.genre}</div>
      </div>
    </div>
  );
}

function ArtDetail({
  work,
  pinned,
  onPin,
  onClose,
}: {
  work: ArtWork;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
}) {
  const [imgErr, setImgErr] = useState(false);

  return (
    <div className="g-detail-overlay" onClick={onClose}>
      <div className="g-detail" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="g-detail-close" onClick={onClose}>✕</button>
        <div className="g-detail-inner">
          <div className="g-detail-img-wrap">
            {!imgErr ? (
              <img
                src={work.imageUrl || work.thumbUrl}
                alt={work.title}
                className="g-detail-img"
                onError={() => setImgErr(true)}
              />
            ) : (
              <div className="g-img-err" style={{ minHeight: 240 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ width: 40, height: 40, opacity: 0.3 }}>
                  <rect x="3" y="4" width="18" height="16" rx="1" />
                  <path d="M3 15l5-5 4 4 3-3 6 6" />
                </svg>
              </div>
            )}
          </div>
          <div className="g-detail-body">
            <div className="g-detail-genre">{work.genre}</div>
            <h2 className="g-detail-title">{work.title}</h2>
            <div className="g-detail-artist">{work.artist}</div>
            {work.year && <div className="g-detail-year">{work.year}</div>}
            {work.medium && (
              <div className="g-detail-row">
                <span className="g-detail-k">Medium</span>
                <span className="g-detail-v">{work.medium}</span>
              </div>
            )}
            {work.department && (
              <div className="g-detail-row">
                <span className="g-detail-k">Collection</span>
                <span className="g-detail-v">{work.department}</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
              <button
                type="button"
                className={`savebtn${pinned ? " active" : ""}`}
                onClick={onPin}
                style={pinned ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}}
              >
                {pinned ? "★ Pinned" : "☆ Pin"}
              </button>
              {(work.metUrl || work.aicUrl) && (
                <a
                  href={work.metUrl || work.aicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="savebtn"
                  onClick={(e) => e.stopPropagation()}
                >
                  View source ↗
                </a>
              )}
              {work.wikiUrl && (
                <a
                  href={work.wikiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="savebtn"
                  onClick={(e) => e.stopPropagation()}
                >
                  Wikidata ↗
                </a>
              )}
            </div>
            {work.isPublicDomain && (
              <p style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 16 }}>
                PUBLIC DOMAIN · FREE TO USE
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PoemPanel() {
  const { poem, next, prev, count } = usePoetry();

  if (!poem) return (
    <div className="g-poem-panel">
      <div className="g-poem-empty">Loading poetry…</div>
    </div>
  );

  return (
    <div className="g-poem-panel">
      <div className="g-poem-eyebrow">Poetry</div>
      <div className="g-poem-title">{poem.title}</div>
      <div className="g-poem-author">— {poem.author}</div>
      <div className="g-poem-lines">
        {poem.lines.slice(0, 14).map((l, i) => (
          <div key={i} className="g-poem-line">{l || <>&nbsp;</>}</div>
        ))}
        {poem.lines.length > 14 && (
          <div className="g-poem-line" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
            … {poem.lines.length - 14} more lines
          </div>
        )}
      </div>
      {count > 1 && (
        <div className="g-poem-nav">
          <button type="button" onClick={prev}>←</button>
          <button type="button" onClick={next}>→</button>
        </div>
      )}
    </div>
  );
}

function ReadingCard({ book }: { book: ReadingItem }) {
  return (
    <a
      href={book.readUrl || book.olUrl || "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="g-book-card"
    >
      {book.coverUrl && (
        <img src={book.coverUrl} alt={book.title} className="g-book-cover" loading="lazy" />
      )}
      <div className="g-book-body">
        <div className="g-book-title">{book.title}</div>
        <div className="g-book-author">{book.author}</div>
        {book.subjects && book.subjects.length > 0 && (
          <div className="g-book-subjects">
            {book.subjects.slice(0, 2).map((s) => (
              <span key={s} className="chip" style={{ fontSize: 8.5, padding: "1px 6px" }}>{s}</span>
            ))}
          </div>
        )}
        {book.downloadCount && book.downloadCount > 0 && (
          <div className="g-book-dl">
            {book.downloadCount.toLocaleString()} downloads
          </div>
        )}
      </div>
    </a>
  );
}

// ── Main module ───────────────────────────────────────────────────────────────

export function GalleryModule() {
  const [tab, setTab] = useState<"art" | "poetry" | "reading">("art");
  const [genre, setGenre] = useState("All");
  const [artQuery, setArtQuery] = useState(ART_QUERIES[0]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(localStorage.getItem("axis-gallery-pins") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const [detail, setDetail] = useState<ArtWork | null>(null);
  const [readMode, setReadMode] = useState<"gutenberg" | "openlibrary">("gutenberg");
  const [readTopic, setReadTopic] = useState(READING_TOPICS[0].key);
  const [readSubject, setReadSubject] = useState(READING_SUBJECTS[0].key);
  const [showPinsOnly, setShowPinsOnly] = useState(false);

  const { works, loading: artLoading } = useGalleryArt(artQuery);
  const { books: readingBooks, loading: readingLoading } = useReading(readTopic, readMode, readSubject);

  const filtered = useMemo(() => {
    let list = works;
    if (genre !== "All") list = list.filter((w) => w.genre === genre);
    if (showPinsOnly) list = list.filter((w) => pinnedIds.has(w.id));
    return list;
  }, [works, genre, showPinsOnly, pinnedIds]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem("axis-gallery-pins", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // Cycle through art queries periodically
  const queryRef = useRef(0);
  const cycleQuery = () => {
    queryRef.current = (queryRef.current + 1) % ART_QUERIES.length;
    setArtQuery(ART_QUERIES[queryRef.current]);
  };

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Life</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Gallery</h1>
      <p className="sub">Museum-curated — art, poetry, and reading.</p>
      <div className="divider" />

      {/* Tab bar */}
      <div className="subtabbar" style={{ marginBottom: 20 }}>
        {(["art", "poetry", "reading"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`subtab${tab === t ? " on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── ART ─────────────────────────────────────────────────────────────── */}
      {tab === "art" && (
        <>
          {/* Toolbar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div className="chips" style={{ marginBottom: 0, flex: 1, minWidth: 0 }}>
              {GENRES.map((g) => (
                <span
                  key={g}
                  className={genre === g ? "chip on" : "chip"}
                  onClick={() => setGenre(g)}
                >
                  {g}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                className={`savebtn${showPinsOnly ? " active" : ""}`}
                style={showPinsOnly ? { borderColor: "var(--gold)", color: "var(--gold)" } : {}}
                onClick={() => setShowPinsOnly((v) => !v)}
              >
                ★ {pinnedIds.size > 0 ? `${pinnedIds.size} pinned` : "Pins"}
              </button>
              <button
                type="button"
                className="savebtn"
                onClick={cycleQuery}
                disabled={artLoading}
              >
                {artLoading ? "Loading…" : "↻ Discover"}
              </button>
            </div>
          </div>

          {/* Grid */}
          {filtered.length === 0 ? (
            <div className="empty-state">
              {showPinsOnly ? "No pinned works yet — pin pieces from the grid." : "No works in this genre."}
            </div>
          ) : (
            <div className="g-grid">
              {filtered.map((work) => (
                <ArtCard
                  key={work.id}
                  work={work}
                  pinned={pinnedIds.has(work.id)}
                  onPin={() => togglePin(work.id)}
                  onOpen={() => setDetail(work)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── POETRY ──────────────────────────────────────────────────────────── */}
      {tab === "poetry" && (
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <PoemPanel />
          <p style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 24, textAlign: "center" }}>
            SOURCED FROM POETRYDB · PUBLIC DOMAIN POETRY
          </p>
        </div>
      )}

      {/* ── READING ─────────────────────────────────────────────────────────── */}
      {tab === "reading" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div className="vtoggle">
              <button
                type="button"
                className={readMode === "gutenberg" ? "on" : ""}
                onClick={() => setReadMode("gutenberg")}
              >
                CLASSICS
              </button>
              <button
                type="button"
                className={readMode === "openlibrary" ? "on" : ""}
                onClick={() => setReadMode("openlibrary")}
              >
                OPEN LIBRARY
              </button>
            </div>
          </div>

          {readMode === "gutenberg" ? (
            <>
              <div className="chips" style={{ marginBottom: 16 }}>
                {READING_TOPICS.map((t) => (
                  <span
                    key={t.key}
                    className={readTopic === t.key ? "chip on" : "chip"}
                    onClick={() => setReadTopic(t.key)}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
              {readingLoading ? (
                <div className="empty-state">Searching Project Gutenberg…</div>
              ) : (
                <div className="g-books-grid">
                  {readingBooks.map((b) => <ReadingCard key={b.id} book={b} />)}
                  {readingBooks.length === 0 && (
                    <div className="empty-state">No classic texts found for this topic.</div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="chips" style={{ marginBottom: 16 }}>
                {READING_SUBJECTS.map((s) => (
                  <span
                    key={s.key}
                    className={readSubject === s.key ? "chip on" : "chip"}
                    onClick={() => setReadSubject(s.key)}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              {readingLoading ? (
                <div className="empty-state">Searching Open Library…</div>
              ) : (
                <div className="g-books-grid">
                  {readingBooks.map((b) => <ReadingCard key={b.id} book={b} />)}
                  {readingBooks.length === 0 && (
                    <div className="empty-state">No books found for this subject.</div>
                  )}
                </div>
              )}
            </>
          )}
          <p style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 24 }}>
            SOURCED FROM PROJECT GUTENBERG · OPEN LIBRARY · ALL WORKS ARE OPEN-ACCESS OR PUBLIC DOMAIN
          </p>
        </>
      )}

      {/* Detail modal */}
      {detail && (
        <ArtDetail
          work={detail}
          pinned={pinnedIds.has(detail.id)}
          onPin={() => togglePin(detail.id)}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}
