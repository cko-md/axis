import { NextResponse } from "next/server";

const MET_BASE    = "https://collectionapi.metmuseum.org/public/collection/v1";
const AIC_BASE    = "https://api.artic.edu/api/v1";
const POETRY_BASE = "https://poetrydb.org";
const GUTENDEX    = "https://gutendex.com/books";
const OL_BASE     = "https://openlibrary.org";

// ── helpers ──────────────────────────────────────────────────────────────────

async function safeFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, { next: { revalidate: 3600 }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ── route ────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const source = searchParams.get("source") ?? "met";
  const q      = searchParams.get("q") ?? "abstract";

  // ── Poetry (PoetryDB) ─────────────────────────────────────────────────────
  if (source === "poetry") {
    const count = Math.min(Number(searchParams.get("count") ?? "5"), 10);
    try {
      const poems = await safeFetch(`${POETRY_BASE}/random/${count}`);
      return NextResponse.json({ poems: Array.isArray(poems) ? poems : [poems] });
    } catch {
      return NextResponse.json({ poems: [] });
    }
  }

  // ── Reading — Gutendex (Project Gutenberg) ────────────────────────────────
  if (source === "reading") {
    const topic = searchParams.get("topic") ?? q;
    try {
      const data = await safeFetch(
        `${GUTENDEX}/?topic=${encodeURIComponent(topic)}&languages=en&mime_type=text%2Fhtml`,
      ) as GutendexResponse;

      const books = (data.results ?? []).slice(0, 16).map((b) => ({
        id: `gut-${b.id}`,
        source: "gutenberg",
        title: b.title,
        author: b.authors.map((a) => a.name).join(", "),
        subjects: b.subjects.slice(0, 4),
        readUrl: b.formats["text/html"] ?? b.formats["text/plain"] ?? "",
        coverUrl: b.formats["image/jpeg"] ?? "",
        downloadCount: b.download_count,
      }));
      return NextResponse.json({ books });
    } catch {
      return NextResponse.json({ books: [] });
    }
  }

  // ── Books — Open Library subject search ───────────────────────────────────
  if (source === "openlibrary") {
    const subject = searchParams.get("subject") ?? "art_history";
    try {
      const data = await safeFetch(
        `${OL_BASE}/subjects/${encodeURIComponent(subject)}.json?limit=20&ebooks=true`,
      ) as OLSubjectResponse;

      const books = (data.works ?? []).map((w) => ({
        id: `ol-${w.key}`,
        source: "openlibrary",
        title: w.title,
        author: w.authors?.map((a) => a.name).join(", ") ?? "Unknown",
        year: w.first_publish_year ?? null,
        coverId: w.cover_id,
        coverUrl: w.cover_id
          ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg`
          : "",
        olUrl: `https://openlibrary.org${w.key}`,
      }));
      return NextResponse.json({ books });
    } catch {
      return NextResponse.json({ books: [] });
    }
  }

  // ── Art Institute of Chicago ──────────────────────────────────────────────
  if (source === "aic") {
    try {
      const data = await safeFetch(
        `${AIC_BASE}/artworks/search?q=${encodeURIComponent(q)}&limit=24` +
        `&fields=id,title,artist_display,date_display,classification_title,image_id,medium_display`,
      ) as { data: AICWork[] };

      const works = (data.data ?? [])
        .filter((w) => w.image_id)
        .map((w) => ({
          id: `aic-${w.id}`,
          source: "aic",
          title: w.title ?? "Untitled",
          artist: w.artist_display ?? "Unknown",
          year: w.date_display ?? "",
          genre: w.classification_title ?? q,
          medium: w.medium_display ?? "",
          imageUrl: `https://www.artic.edu/iiif/2/${w.image_id}/full/843,/0/default.jpg`,
          thumbUrl: `https://www.artic.edu/iiif/2/${w.image_id}/full/400,/0/default.jpg`,
          aicUrl: `https://www.artic.edu/artworks/${w.id}`,
        }));
      return NextResponse.json({ works });
    } catch {
      return NextResponse.json({ works: [] });
    }
  }

  // ── Metropolitan Museum (default) ─────────────────────────────────────────
  try {
    const searchData = await safeFetch(
      `${MET_BASE}/search?q=${encodeURIComponent(q)}&hasImages=true&isHighlight=true`,
    ) as { objectIDs?: number[]; total?: number };

    const ids = (searchData.objectIDs ?? []).slice(0, 32);

    const settled = await Promise.allSettled(
      ids.slice(0, 16).map((id) =>
        fetch(`${MET_BASE}/objects/${id}`, { next: { revalidate: 86400 } }).then((r) => r.json()),
      ),
    );

    const works = settled
      .filter((r): r is PromiseFulfilledResult<MetWork> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((w) => w.primaryImageSmall)
      .map((w) => ({
        id: `met-${w.objectID}`,
        source: "met",
        title: w.title ?? "Untitled",
        artist: w.artistDisplayName ?? "Unknown",
        year: w.objectDate ?? "",
        genre: w.classification ?? w.medium ?? "",
        medium: w.medium ?? "",
        department: w.department ?? "",
        imageUrl: w.primaryImage || w.primaryImageSmall,
        thumbUrl: w.primaryImageSmall,
        metUrl: w.objectURL ?? "",
        wikiUrl: w.objectWikidata_URL ?? "",
        isPublicDomain: w.isPublicDomain,
      }));

    return NextResponse.json({ works });
  } catch {
    return NextResponse.json({ works: [] });
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type MetWork = {
  objectID: number;
  title: string;
  artistDisplayName: string;
  objectDate: string;
  classification: string;
  medium: string;
  department: string;
  primaryImage: string;
  primaryImageSmall: string;
  objectURL: string;
  objectWikidata_URL: string;
  isPublicDomain: boolean;
};

type AICWork = {
  id: number;
  title: string;
  artist_display: string;
  date_display: string;
  classification_title: string;
  image_id: string;
  medium_display: string;
};

type GutendexResponse = {
  results: Array<{
    id: number;
    title: string;
    authors: Array<{ name: string; birth_year?: number; death_year?: number }>;
    subjects: string[];
    formats: Record<string, string>;
    download_count: number;
  }>;
};

type OLSubjectResponse = {
  works: Array<{
    key: string;
    title: string;
    authors?: Array<{ name: string }>;
    first_publish_year?: number;
    cover_id?: number;
  }>;
};
