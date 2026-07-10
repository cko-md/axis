import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { endOfLocalDay, eventOccursOnLocalDay, startOfLocalDay } from "./event-dates";

export type TodayOwnedEvent = {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  description?: string | null;
  color_class?: string | null;
  all_day?: boolean | null;
};

export type TodayMergedEvent = TodayOwnedEvent & {
  source?: "google" | "outlook";
};

type CachedExternalEvent = {
  externalId: string;
  title: string;
  start_at: string;
  end_at: string;
  description?: string | null;
  location?: string | null;
  attendees?: string[];
  all_day: boolean;
};

export function mergeTodayEvents(
  owned: TodayOwnedEvent[],
  cacheRows: Array<{ source: "google" | "outlook"; events: CachedExternalEvent[] | null }>,
  day = new Date(),
): TodayMergedEvent[] {
  const external: TodayMergedEvent[] = [];
  for (const row of cacheRows) {
    for (const event of row.events ?? []) {
      if (!eventOccursOnLocalDay(event.start_at, event.all_day, day)) continue;
      external.push({
        id: `ext-${row.source}-${event.externalId}`,
        title: event.title,
        description: event.description ?? null,
        start_at: event.start_at,
        end_at: event.end_at,
        color_class: "or",
        all_day: event.all_day,
        source: row.source,
      });
    }
  }

  return [...owned, ...external].sort(
    (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
  );
}

export async function fetchTodayMergedEvents(
  supabase: SupabaseClient<Database>,
  userId: string,
  day = new Date(),
): Promise<TodayMergedEvent[]> {
  const start = startOfLocalDay(day);
  const end = endOfLocalDay(day);
  const lookback = new Date(start);
  lookback.setDate(lookback.getDate() - 1);
  const lookahead = new Date(end);
  lookahead.setDate(lookahead.getDate() + 1);

  const [ownedRes, cacheRes] = await Promise.all([
    supabase
      .from("schedule_events")
      .select("id, title, description, start_at, end_at, color_class, all_day")
      .eq("user_id", userId)
      .gte("start_at", lookback.toISOString())
      .lte("start_at", lookahead.toISOString())
      .order("start_at", { ascending: true }),
    supabase.from("calendar_event_cache").select("source, events"),
  ]);

  if (ownedRes.error) throw ownedRes.error;

  const ownedFiltered = ((ownedRes.data ?? []) as TodayOwnedEvent[]).filter((event) =>
    eventOccursOnLocalDay(event.start_at, Boolean(event.all_day), day),
  );

  return mergeTodayEvents(
    ownedFiltered,
    (cacheRes.data ?? []) as Array<{ source: "google" | "outlook"; events: CachedExternalEvent[] | null }>,
    day,
  );
}
