import { NextResponse } from "next/server";

// ── Literature feed ───────────────────────────────────────────────────────────
// Aggregates REAL recent neuroscience-relevant articles from free, no-auth sources:
//   • PubMed E-utilities (esearch + esummary) — peer-reviewed
//   • bioRxiv / medRxiv detail API — preprints
//   • arXiv q-bio Atom API — quantitative-biology preprints
// Each source degrades independently: a single unreachable source never breaks the
// response. Results are normalized to the Article shape and cached server-side.

export const revalidate = 0; // we manage caching ourselves below

export type Article = {
  id: string;
  title: string;
  authors: string;
  source: string; // human label, e.g. "PubMed", "bioRxiv", "arXiv q-bio"
  summary: string;
  url: string;
  publishedAt: string; // ISO date
};

type FeedResponse = {
  articles: Article[];
  sources: { name: string; ok: boolean; count: number }[];
  query: string;
  fetchedAt: string;
  fallback?: boolean;
};

// Curated topic → per-source query map. Keeps the feed legibly neuroscience-shaped.
const TOPICS: Record<string, { label: string; pubmed: string; biorxiv: string; arxiv: string }> = {
  neuroscience: {
    label: "Neuroscience",
    pubmed: "neuroscience[Title/Abstract] AND (brain OR neural OR cortex)",
    biorxiv: "neuroscience",
    arxiv: "neuroscience",
  },
  dbs: {
    label: "DBS / Functional",
    pubmed: "deep brain stimulation[Title/Abstract]",
    biorxiv: "deep brain stimulation",
    arxiv: "deep brain stimulation",
  },
  connectomics: {
    label: "Connectomics",
    pubmed: "connectome[Title/Abstract] OR connectomics[Title/Abstract]",
    biorxiv: "connectome",
    arxiv: "connectome",
  },
  neurooncology: {
    label: "Neuro-Oncology",
    pubmed: "glioma[Title/Abstract] OR glioblastoma[Title/Abstract]",
    biorxiv: "glioma",
    arxiv: "glioma",
  },
  methods: {
    label: "Methods / Stats",
    pubmed: "survival analysis[Title/Abstract] AND (neurosurgery OR neurology)",
    biorxiv: "statistical methods neuroscience",
    arxiv: "neural data analysis",
  },
};

// ── Server-side cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, { at: number; payload: FeedResponse }>();

const TIMEOUT_MS = 8000;

async function fetchJSON(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": "Axis-Literature/1.0 (personal research dashboard)", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Axis-Literature/1.0 (personal research dashboard)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

// ── PubMed (E-utilities, no key required) ───────────────────────────────────────
async function fetchPubMed(query: string, limit: number): Promise<Article[]> {
  const esearch = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  esearch.searchParams.set("db", "pubmed");
  esearch.searchParams.set("term", query);
  esearch.searchParams.set("retmax", String(limit));
  esearch.searchParams.set("retmode", "json");
  esearch.searchParams.set("sort", "date");

  const searchData = (await fetchJSON(esearch.toString())) as {
    esearchresult?: { idlist?: string[] };
  };
  const ids = searchData.esearchresult?.idlist ?? [];
  if (!ids.length) return [];

  const esummary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
  esummary.searchParams.set("db", "pubmed");
  esummary.searchParams.set("id", ids.join(","));
  esummary.searchParams.set("retmode", "json");

  const sumData = (await fetchJSON(esummary.toString())) as {
    result?: Record<string, unknown>;
  };
  const result = sumData.result ?? {};

  return ids
    .map((id): Article | null => {
      const r = result[id] as
        | {
            title?: string;
            authors?: { name?: string }[];
            source?: string;
            fulljournalname?: string;
            pubdate?: string;
            elocationid?: string;
          }
        | undefined;
      if (!r?.title) return null;
      const authorNames = (r.authors ?? []).map((a) => a.name).filter(Boolean) as string[];
      const authors =
        authorNames.length > 3
          ? `${authorNames.slice(0, 3).join(", ")}, et al.`
          : authorNames.join(", ") || "—";
      const journal = r.fulljournalname || r.source || "PubMed";
      return {
        id: `pmid:${id}`,
        title: stripTags(r.title),
        authors,
        source: "PubMed",
        summary: `${journal}. Indexed in MEDLINE/PubMed. Peer-reviewed publication.`,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        publishedAt: normalizeDate(r.pubdate),
      };
    })
    .filter((a): a is Article => a !== null);
}

// ── bioRxiv / medRxiv (public detail API, no key) ───────────────────────────────
async function fetchBioRxiv(
  server: "biorxiv" | "medrxiv",
  limit: number,
  keyword?: string,
): Promise<Article[]> {
  // Recent window: last 30 days. The /details/{server}/{from}/{to}/{cursor} endpoint
  // returns the most recent deposits; we take the freshest slice.
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://api.biorxiv.org/details/${server}/${fmt(from)}/${fmt(to)}/0`;

  const data = (await fetchJSON(url)) as {
    collection?: {
      doi?: string;
      title?: string;
      authors?: string;
      date?: string;
      abstract?: string;
      category?: string;
    }[];
  };
  const collection = data.collection ?? [];
  // The detail API has no text search, so we filter client-side: a custom keyword
  // narrows to matching title/abstract; otherwise keep neuro-relevant categories.
  const kw = keyword?.toLowerCase().trim();
  const neuro = collection
    .filter((c) => {
      const cat = (c.category ?? "").toLowerCase();
      const text = `${c.title ?? ""} ${c.abstract ?? ""}`.toLowerCase();
      if (kw) {
        // match on the most distinctive words of the query
        const terms = kw.split(/\s+/).filter((t) => t.length > 3);
        return terms.length ? terms.some((t) => text.includes(t)) : text.includes(kw);
      }
      return (
        cat.includes("neuro") ||
        cat.includes("brain") ||
        text.match(/brain|neural|neuron|cortex|cognit/) !== null
      );
    })
    .reverse()
    .slice(0, limit);

  const label = server === "biorxiv" ? "bioRxiv" : "medRxiv";
  return neuro
    .map((c): Article | null => {
      if (!c.title || !c.doi) return null;
      const authors = (c.authors ?? "")
        .split(";")
        .map((a) => a.trim())
        .filter(Boolean);
      const authorStr =
        authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", ") || "—";
      return {
        id: `doi:${c.doi}`,
        title: stripTags(c.title),
        authors: authorStr,
        source: label,
        summary: c.abstract ? clamp(stripTags(c.abstract), 320) : `${label} preprint — not yet peer-reviewed.`,
        url: `https://doi.org/${c.doi}`,
        publishedAt: normalizeDate(c.date),
      };
    })
    .filter((a): a is Article => a !== null);
}

// ── arXiv q-bio (Atom feed, no key) ─────────────────────────────────────────────
async function fetchArxiv(query: string, limit: number): Promise<Article[]> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `cat:q-bio.NC AND all:${query}`);
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");
  url.searchParams.set("max_results", String(limit));

  const xml = await fetchText(url.toString());
  const entries = xml.split("<entry>").slice(1);
  return entries
    .map((entry): Article | null => {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1];
      const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1];
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
      if (!title || !id) return null;
      const authorStr =
        authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", ") || "—";
      return {
        id: `arxiv:${id.split("/abs/")[1] ?? id}`,
        title: stripTags(title),
        authors: authorStr,
        source: "arXiv q-bio",
        summary: summary ? clamp(stripTags(summary), 320) : "arXiv q-bio.NC preprint.",
        url: id.trim(),
        publishedAt: normalizeDate(published),
      };
    })
    .filter((a): a is Article => a !== null);
}

function normalizeDate(raw?: string): string {
  if (!raw) return new Date().toISOString();
  // PubMed dates look like "2026 May 28" or "2026 May"; ISO and yyyy-mm-dd parse fine.
  const d = new Date(raw.replace(/(\d{4}) (\w{3})/, "$2 1, $1"));
  if (!isNaN(d.getTime())) return d.toISOString();
  const d2 = new Date(raw);
  return isNaN(d2.getTime()) ? new Date().toISOString() : d2.toISOString();
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // `topic` may be a single key or a comma-separated set; we merge across them.
  const rawKeys = (params.get("topic") || "neuroscience")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const topicKeys = rawKeys.length ? rawKeys : ["neuroscience"];
  const customQuery = params.get("q")?.trim();

  const cacheKey = customQuery ? `q:${customQuery}` : `t:${[...topicKeys].sort().join("+")}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS && !params.has("nocache")) {
    return NextResponse.json({ ...cached.payload, cached: true });
  }

  // Build per-source query terms. Unknown keys fall back to verbatim free-text search.
  const topicDefs = topicKeys.map((k) =>
    TOPICS[k] ?? { label: k, pubmed: k, biorxiv: k, arxiv: k },
  );
  const pubmedQuery = customQuery || topicDefs.map((t) => `(${t.pubmed})`).join(" OR ");
  const biorxivKeyword = customQuery || topicDefs.map((t) => t.biorxiv).join(" ");
  const arxivQuery = customQuery || topicDefs.map((t) => t.arxiv).join(" OR ");
  const label = customQuery || topicDefs.map((t) => t.label).join(" · ");

  const sources: { name: string; ok: boolean; count: number }[] = [];

  const settled = await Promise.allSettled([
    fetchPubMed(pubmedQuery, 14),
    fetchBioRxiv("biorxiv", 6, biorxivKeyword),
    fetchBioRxiv("medrxiv", 4, biorxivKeyword),
    fetchArxiv(arxivQuery, 6),
  ]);

  const names = ["PubMed", "bioRxiv", "medRxiv", "arXiv q-bio"];
  const collected: Article[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      sources.push({ name: names[i], ok: true, count: s.value.length });
      collected.push(...s.value);
    } else {
      sources.push({ name: names[i], ok: false, count: 0 });
    }
  });

  // De-dupe by id, sort newest first.
  const seen = new Set<string>();
  const articles = collected
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));

  const payload: FeedResponse = {
    articles,
    sources,
    query: label,
    fetchedAt: new Date().toISOString(),
    fallback: articles.length === 0,
  };

  // Only cache successful, non-empty payloads so a transient outage doesn't get pinned.
  if (articles.length > 0) cache.set(cacheKey, { at: now, payload });

  return NextResponse.json(payload);
}
