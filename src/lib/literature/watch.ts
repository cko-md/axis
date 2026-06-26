import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPubMed, fetchBioRxiv, fetchArxiv, buildQueries, type Article } from "@/lib/literature/sources";

const LAST_SEEN_CAP = 50;
const MAX_REPORTED = 5;

export type NewPaperMatch = { id: string; title: string; url: string; source: string };

/**
 * Shared core for the Literature paper-watch: reads the user's saved topics,
 * queries the same PubMed/bioRxiv/arXiv sources the on-demand feed uses, and
 * returns up to 5 articles the user hasn't seen before (via literature_saved
 * and the last_seen_ids tracking column). Only the ids actually returned are
 * marked as seen — any extra fresh matches beyond the top 5 stay eligible to
 * surface on the next sweep rather than being silently dropped forever.
 *
 * Returns [] for users who've never set Literature topics (no literature_prefs
 * row) — same "don't nag an unused feature" convention as the Debrief
 * staleness check. Does NOT write a signal — the cron route wraps the result,
 * same pattern as scanForObjectives.
 */
export async function scanForNewPapers(
  userId: string,
  supabase: SupabaseClient,
): Promise<NewPaperMatch[]> {
  const { data: prefs } = await supabase
    .from("literature_prefs")
    .select("topics, last_seen_ids")
    .eq("user_id", userId)
    .maybeSingle();

  if (!prefs) return [];

  const topics = Array.isArray(prefs.topics) && prefs.topics.length ? (prefs.topics as string[]) : ["neuroscience"];
  const lastSeenIds: string[] = Array.isArray(prefs.last_seen_ids) ? (prefs.last_seen_ids as string[]) : [];

  const { pubmedQuery, biorxivKeyword, arxivQuery } = buildQueries(topics);

  let collected: Article[] = [];
  try {
    const settled = await Promise.allSettled([
      fetchPubMed(pubmedQuery, 10),
      fetchBioRxiv("biorxiv", 5, biorxivKeyword),
      fetchBioRxiv("medrxiv", 3, biorxivKeyword),
      fetchArxiv(arxivQuery, 5),
    ]);
    collected = settled
      .filter((s): s is PromiseFulfilledResult<Article[]> => s.status === "fulfilled")
      .flatMap((s) => s.value)
      .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));
  } catch {
    return [];
  }
  if (!collected.length) return [];

  const { data: savedRows } = await supabase
    .from("literature_saved")
    .select("article_id")
    .eq("user_id", userId);
  const savedIds = new Set((savedRows ?? []).map((r) => r.article_id as string));
  const seenIds = new Set(lastSeenIds);

  const seenInThisRun = new Set<string>();
  const fresh = collected.filter((a) => {
    if (savedIds.has(a.id) || seenIds.has(a.id) || seenInThisRun.has(a.id)) return false;
    seenInThisRun.add(a.id);
    return true;
  });
  if (!fresh.length) return [];

  const toReport = fresh.slice(0, MAX_REPORTED);
  const nextSeen = [...lastSeenIds, ...toReport.map((a) => a.id)].slice(-LAST_SEEN_CAP);
  await supabase.from("literature_prefs").update({ last_seen_ids: nextSeen }).eq("user_id", userId);

  return toReport.map((a) => ({ id: a.id, title: a.title, url: a.url, source: a.source }));
}
