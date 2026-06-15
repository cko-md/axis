import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const AIC_BASE    = "https://api.artic.edu/api/v1";
const MET_BASE    = "https://collectionapi.metmuseum.org/public/collection/v1";
const CMA_BASE    = "https://openaccess-api.clevelandart.org/api";    // free, no key
const POETRY_BASE = "https://poetrydb.org";
const GUTENDEX    = "https://gutendex.com/books";
const OL_BASE     = "https://openlibrary.org";

// ── Curated queries by movement ───────────────────────────────────────────────

const AIC_QUERIES: Record<string, string[]> = {
  Expressionism:          ["expressionism painting", "kirchner expressionism", "ernst ludwig kirchner"],
  Impressionism:          ["impressionism monet", "impressionist landscape", "renoir impressionism"],
  Abstract:               ["abstract expressionism", "color field painting", "abstract composition"],
  Modern:                 ["modern art", "modernist painting", "bauhaus design"],
  Sculpture:              ["rodin sculpture", "bronze sculpture", "marble sculpture"],
  Minimalism:             ["minimalism art", "geometric abstraction", "frank stella"],
  Surrealism:             ["surrealism painting", "dali surrealism", "magritte surrealism"],
  Hyperrealism:           ["hyperrealism painting", "photorealist painting"],
  "Text Art":             ["text art conceptual", "word painting letters"],
  Cubism:                 ["cubism picasso", "cubist composition", "braque cubism"],
  "Pop Art":              ["pop art warhol", "pop art lichtenstein", "pop art collage"],
  Classicism:             ["classical painting allegory", "neoclassical figure"],
  Rococo:                 ["rococo fragonard", "rococo watteau", "rococo boucher"],
  Romanticism:            ["romanticism delacroix", "romantic landscape turner", "caspar david friedrich"],
  "Post-Impressionism":   ["post impressionism cezanne", "van gogh post impressionism", "gauguin"],
  Futurism:               ["futurism boccioni", "italian futurism", "futurist composition"],
  Figurative:             ["figurative painting portrait", "figurative modern figure"],
  "Fine Art":             ["fine art masterwork", "old masters painting"],
  Neoclassicism:          ["neoclassicism david", "neoclassical allegory", "ingres neoclassicism"],
  "Neo-Impressionism":    ["seurat pointillism", "neo impressionism signac", "divisionism"],
  Baroque:                ["baroque painting caravaggio", "baroque dutch golden age", "rembrandt baroque"],
  Renaissance:            ["renaissance italian painting", "botticelli renaissance painting", "raphael renaissance"],
  "Art Deco":             ["art deco design illustration", "art deco poster modernism", "art deco decorative"],
  Photography:            ["photography documentary", "photography portrait", "photography landscape"],
  "Asian Art":            ["japanese woodblock print", "ukiyo-e woodblock", "hokusai wave"],
  "Islamic Art":          ["islamic geometric art", "persian manuscript painting", "arabic calligraphy art"],
  "African American Art": ["african american art chicago", "african american modernism", "social realism painting"],
  Afrofuturism:           ["kerry james marshall", "kehinde wiley", "sam gilliam"],
};

const MET_QUERIES: Record<string, string[]> = {
  "Harlem Renaissance":   ["Jacob Lawrence", "Aaron Douglas", "Romare Bearden", "Harlem Renaissance"],
  "African American Art": ["Romare Bearden", "faith ringgold", "african american art twentieth century"],
  Afrofuturism:           ["contemporary African art", "African diaspora modern", "black abstract expressionism"],
  "Islamic Art":          ["islamic art geometric", "persian miniature", "ottoman art"],
  "Asian Art":            ["Japanese painting Edo", "Chinese ink painting", "Korean ceramics"],
};

// Cleveland Museum of Art — free open-access API, no key required
const CMA_QUERIES: Record<string, string[]> = {
  Impressionism:         ["monet", "renoir", "pissarro"],
  "Post-Impressionism":  ["van gogh", "cezanne", "gauguin"],
  Baroque:               ["rembrandt", "rubens", "caravaggio"],
  Renaissance:           ["raphael", "titian", "botticelli"],
  Romanticism:           ["turner", "delacroix", "constable"],
  "African American Art":["henry ossawa tanner", "romare bearden"],
  "Asian Art":           ["japanese woodblock", "chinese painting", "ink painting"],
  "Islamic Art":         ["persian", "ottoman", "islamic manuscript"],
  Photography:           ["alfred stieglitz", "edward weston", "berenice abbott"],
  Sculpture:             ["rodin", "brancusi", "degas sculpture"],
};


const ALL_AIC_QUERIES = Object.values(AIC_QUERIES).flat();
const ALL_MET_QUERIES = Object.values(MET_QUERIES).flat();
const ALL_CMA_QUERIES = Object.values(CMA_QUERIES).flat();

// ── Curated poets ─────────────────────────────────────────────────────────────

const CURATED_POETS = [
  "William Blake",
  "Walt Whitman",
  "Emily Dickinson",
  "Langston Hughes",
  "Gwendolyn Brooks",
  "T.S. Eliot",
  "Wallace Stevens",
];

// PoetryDB search names (some need simplified author strings)
const POET_DB_NAMES: Record<string, string> = {
  "Rainer Maria Rilke": "Rilke",
  "Pablo Neruda":       "Neruda",
  "Amiri Baraka":       "Baraka",
};

// ── Open Library subjects ──────────────────────────────────────────────────────

const OL_SUBJECTS = [
  "art_criticism",
  "aesthetics",
  "architectural_theory",
  "cultural_theory",
  "philosophy_of_art",
  "art_history",
  "modernism",
  "surrealism_art",
  "expressionism",
  "impressionism_art",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, { next: { revalidate: 3600 }, ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const source      = searchParams.get("source") ?? "aic";
  const q           = searchParams.get("q") ?? "";
  const allowNonPD  = searchParams.get("allowNonPD") === "1";

  // ── AIC (Art Institute of Chicago) ────────────────────────────────────────
  if (source === "aic") {
    const query = q || pick(ALL_AIC_QUERIES);
    const pdFilter = allowNonPD ? "" : `&query[term][is_public_domain]=true`;
    try {
      const data = await safeFetch(
        `${AIC_BASE}/artworks/search?q=${encodeURIComponent(query)}&limit=24` +
        `&fields=id,title,artist_display,date_display,classification_title,image_id,` +
        `medium_display,artist_title,thumbnail,department_title,place_of_origin` +
        pdFilter,
      ) as { data: AICWork[] };

      const derivedGenre = deriveGenre(query);
      const works = (data.data ?? [])
        .filter((w) => w.image_id)
        .map((w) => ({
          id: `aic-${w.id}`,
          source: "aic",
          title: w.title ?? "Untitled",
          artist: w.artist_display ?? w.artist_title ?? "Unknown",
          artistTitle: w.artist_title ?? "",
          year: w.date_display ?? "",
          genre: derivedGenre !== "Fine Art" ? derivedGenre : (w.classification_title ?? "Fine Art"),
          medium: w.medium_display ?? "",
          department: w.department_title ?? "",
          origin: w.place_of_origin ?? "",
          imageUrl: `https://www.artic.edu/iiif/2/${w.image_id}/full/843,/0/default.jpg`,
          thumbUrl: `https://www.artic.edu/iiif/2/${w.image_id}/full/400,/0/default.jpg`,
          aicUrl: `https://www.artic.edu/artworks/${w.id}`,
          isPublicDomain: true,
        }));
      return NextResponse.json({ works, query }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ works: [], query });
    }
  }

  // ── MET (Metropolitan Museum) ────────────────────────────────────────────
  if (source === "met") {
    const query = q || pick(ALL_MET_QUERIES);
    const artistSearch = searchParams.get("artistSearch") === "1";
    try {
      const metSearchUrl = `${MET_BASE}/search?q=${encodeURIComponent(query)}&hasImages=true${artistSearch ? "&artistOrCulture=true" : ""}`;
      const searchData = await safeFetch(metSearchUrl) as { objectIDs?: number[] };

      const ids = (searchData.objectIDs ?? []).slice(0, 16);
      const settled = await Promise.allSettled(
        ids.map((id) => fetch(`${MET_BASE}/objects/${id}`, { next: { revalidate: 86400 } }).then((r) => r.json())),
      );

      const derivedMetGenre = deriveGenre(query);
      const works = settled
        .filter((r): r is PromiseFulfilledResult<MetWork> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((w) => w.primaryImageSmall)
        .map((w) => ({
          id: `met-${w.objectID}`,
          source: "met",
          title: w.title ?? "Untitled",
          artist: w.artistDisplayName ?? "Unknown",
          artistTitle: w.artistDisplayName ?? "",
          year: w.objectDate ?? "",
          genre: derivedMetGenre !== "Fine Art" ? derivedMetGenre : (w.classification ?? w.medium ?? "Fine Art"),
          medium: w.medium ?? "",
          department: w.department ?? "",
          origin: w.country ?? "",
          imageUrl: w.primaryImage || w.primaryImageSmall,
          thumbUrl: w.primaryImageSmall,
          metUrl: w.objectURL ?? "",
          wikiUrl: w.objectWikidata_URL ?? "",
          isPublicDomain: w.isPublicDomain,
        }));

      return NextResponse.json({ works, query }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ works: [], query });
    }
  }

  // ── Cleveland Museum of Art (free, no auth) ─────────────────────────────
  if (source === "cma") {
    const query = q || pick(ALL_CMA_QUERIES);
    try {
      const data = await safeFetch(
        `${CMA_BASE}/artworks/?q=${encodeURIComponent(query)}&has_image=1&limit=24&fields=id,title,creators,creation_date,technique,department,images,url,culture`,
      ) as { data: CMAWork[] };

      const derivedGenre = deriveGenre(query);
      const works = (data.data ?? [])
        .filter((w) => w.images?.web?.url)
        .map((w) => ({
          id: `cma-${w.id}`,
          source: "cma",
          title: w.title ?? "Untitled",
          artist: w.creators?.map((c) => c.description).join(", ") ?? "Unknown",
          artistTitle: w.creators?.[0]?.description ?? "",
          year: w.creation_date ?? "",
          genre: derivedGenre !== "Fine Art" ? derivedGenre : (w.technique ?? w.department ?? "Fine Art"),
          medium: w.technique ?? "",
          department: w.department ?? "",
          origin: w.culture ?? "",
          imageUrl: w.images?.web?.url ?? "",
          thumbUrl: w.images?.web?.url ?? "",
          cmaUrl: w.url ?? "",
          isPublicDomain: true,
        }));
      return NextResponse.json({ works, query }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ works: [], query });
    }
  }

  // ── Poetry (PoetryDB) ─────────────────────────────────────────────────────
  if (source === "poems") {
    try {
      // Pick 2-3 random poets and fetch 3 poems each
      const shuffled = [...CURATED_POETS].sort(() => Math.random() - 0.5).slice(0, 3);
      const results = await Promise.allSettled(
        shuffled.map(async (poet) => {
          const dbName = POET_DB_NAMES[poet] ?? poet;
          const url = `${POETRY_BASE}/author/${encodeURIComponent(dbName)}/title,author,lines,linecount`;
          const data = await safeFetch(url) as PoetryDBPoem[] | { status: number };
          if (!Array.isArray(data)) return [];
          // Pick 3 poems per author
          return data.slice(0, 3).map((p) => ({
            title: p.title,
            author: p.author,
            lines: p.lines,
            linecount: p.linecount,
          }));
        }),
      );

      const poems = results
        .filter((r): r is PromiseFulfilledResult<PoetryDBPoem[]> => r.status === "fulfilled")
        .flatMap((r) => r.value);

      return NextResponse.json({ poems }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ poems: [] });
    }
  }

  // ── Legacy poetry endpoint (random) ──────────────────────────────────────
  if (source === "poetry") {
    const count = Math.min(Number(searchParams.get("count") ?? "5"), 10);
    try {
      const poems = await safeFetch(`${POETRY_BASE}/random/${count}`);
      return NextResponse.json(
        { poems: Array.isArray(poems) ? poems : [poems] },
        { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } },
      );
    } catch {
      return NextResponse.json({ poems: [] });
    }
  }

  // ── Articles — Open Library art/culture subjects ──────────────────────────
  if (source === "articles") {
    const subjectParam = searchParams.get("subject");
    const subject = subjectParam ?? pick(OL_SUBJECTS);
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
        coverUrl: w.cover_id
          ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg`
          : "",
        olUrl: `https://openlibrary.org${w.key}`,
        subjects: [],
      }));
      return NextResponse.json({ books, subject }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ books: [], subject });
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
        year: null,
      }));
      return NextResponse.json({ books }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ books: [] });
    }
  }

  // ── Open Library (legacy) ─────────────────────────────────────────────────
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
        coverUrl: w.cover_id
          ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg`
          : "",
        olUrl: `https://openlibrary.org${w.key}`,
        subjects: [],
      }));
      return NextResponse.json({ books }, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" } });
    } catch {
      return NextResponse.json({ books: [] });
    }
  }

  return NextResponse.json({ error: "Unknown source" }, { status: 400 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveGenre(query: string): string {
  const q = query.toLowerCase();
  for (const [genre, queries] of Object.entries(AIC_QUERIES)) {
    if (queries.some((aq) => q.includes(aq.toLowerCase()) || aq.toLowerCase().includes(q))) {
      return genre;
    }
  }
  for (const [genre, queries] of Object.entries(MET_QUERIES)) {
    if (queries.some((mq) => q.includes(mq.toLowerCase()) || mq.toLowerCase().includes(q))) {
      return genre;
    }
  }
  return "Fine Art";
}

// ── Types ─────────────────────────────────────────────────────────────────────

type AICWork = {
  id: number;
  title: string;
  artist_display: string;
  artist_title: string;
  date_display: string;
  classification_title: string;
  image_id: string;
  medium_display: string;
  department_title: string;
  place_of_origin: string;
  thumbnail: { alt_text?: string } | null;
};

type MetWork = {
  objectID: number;
  title: string;
  artistDisplayName: string;
  objectDate: string;
  classification: string;
  medium: string;
  department: string;
  country: string;
  primaryImage: string;
  primaryImageSmall: string;
  objectURL: string;
  objectWikidata_URL: string;
  isPublicDomain: boolean;
};

type PoetryDBPoem = {
  title: string;
  author: string;
  lines: string[];
  linecount: string;
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

type CMAWork = {
  id: number;
  title: string;
  creators?: Array<{ description: string; role?: string }>;
  creation_date?: string;
  technique?: string;
  department?: string;
  culture?: string;
  url?: string;
  images?: { web?: { url: string } };
};
