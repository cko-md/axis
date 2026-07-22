import { NextRequest, NextResponse } from "next/server";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";
import { seededIndex } from "@/lib/content/daily";
import { CURATED_POEMS, FALLBACK_POEMS, type PoemPayload } from "@/lib/content/poems";

type PoetryDbPoem = {
  title: string;
  author: string;
  lines: string[];
};

// Mirrors /api/widgets/art: a seed (the client's local day number, or any
// offset the "Next" button advances to) deterministically picks one entry
// from the curated public-domain corpus. Same seed, same poem — no re-roll
// on refresh. PoetryDB outages degrade to a bundled poem instead of an
// empty card; the fallback pick is salted so it doesn't shadow the curated
// rotation's ordering.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const seed = parseInt(req.nextUrl.searchParams.get("seed") ?? "0", 10)
    || Math.floor(Date.now() / 86_400_000);
  const pick = CURATED_POEMS[seededIndex(seed, CURATED_POEMS.length)];

  try {
    const url = `https://poetrydb.org/author,title/${encodeURIComponent(pick.author)};${encodeURIComponent(pick.title)}:abs/title,author,lines`;
    const res = await timedProviderFetch(
      url,
      { next: { revalidate: 3600 } },
      { area: "console", provider: "poetrydb", operation: "poem_fetch", timeoutMs: 5_000, slowMs: 1_500 },
    );
    if (!res.ok) throw new Error(`PoetryDB ${res.status}`);

    const json = (await res.json()) as PoetryDbPoem[] | { status: number };
    if (!Array.isArray(json) || json.length === 0) throw new Error("Poem not found");

    // Ambiguous titles can match more than one poem; the shortest fits the card.
    const poem = [...json].sort((a, b) => a.lines.length - b.lines.length)[0];
    if (!poem?.lines?.length) throw new Error("Poem empty");

    const payload: PoemPayload = {
      title: poem.title,
      author: poem.author,
      lines: poem.lines,
      source: "poetrydb",
    };
    logRouteTiming("/api/widgets/poem", routeStartedAt, { fallback: false });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch {
    const fallback = FALLBACK_POEMS[seededIndex(seed, FALLBACK_POEMS.length, 1)];
    logRouteTiming("/api/widgets/poem", routeStartedAt, { fallback: true });
    // Still a 200: the card shows a real poem either way, just from the
    // bundled corpus, and the shorter cache window retries the provider soon.
    return NextResponse.json(fallback, {
      headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" },
    });
  }
}
