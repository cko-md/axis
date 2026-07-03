"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hourLabel } from "@/lib/format";
import type { ScheduleEvent } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { AddCalendarPicker } from "./AddCalendarPicker";
import { formatCalendarFreshness } from "@/lib/calendar/freshness";

type ComposioCalState = { active: boolean; email: string | null };
type CalendarStatusResponse = {
  google: boolean;
  googleEmail: string | null;
  outlook: boolean;
  outlookEmail: string | null;
  error?: string;
};

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type ChipColor = "a" | "b" | "c" | "or";
type LocalColor = "a" | "b" | "c";
type DetailMode = "view" | "edit";
type EventChip = { cls: ChipColor; title: string; event?: ScheduleEvent };
type EventEditForm = { title: string; description: string; startAt: string; endAt: string; color: LocalColor };

const COLOR_OPTIONS: Array<{ value: LocalColor; label: string }> = [
  { value: "a", label: "Teal — Deep work" },
  { value: "b", label: "Green — Wellness" },
  { value: "c", label: "Clay — Meetings" },
];

// Static sample chips sprinkled on fixed days of the current month (Phase-3 stub).
const MONTH_SAMPLE_EVENTS: Record<number, Array<{ cls: ChipColor; title: string }>> = {
  3: [{ cls: "a", title: "Deep Work" }],
  8: [{ cls: "b", title: "Zone-2 Run" }],
  12: [{ cls: "c", title: "Lab Meeting" }],
  18: [{ cls: "a", title: "Manuscript" }],
  24: [{ cls: "b", title: "Long Run" }],
  27: [{ cls: "c", title: "Clinic Review" }],
};

const DAY_SAMPLE_ROWS: Array<{ time: string; title: string; now: boolean; event?: ScheduleEvent }> = [
  { time: "07:00", title: "Zone-2 Run · 8 km", now: false },
  { time: "09:30", title: "DBS Manuscript — Discussion", now: true },
  { time: "12:00", title: "Lab Meeting · Dr. Adeyemi", now: false },
  { time: "14:00", title: "Cox PH Analysis Block", now: false },
];

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function eventToEditForm(event: ScheduleEvent): EventEditForm {
  return {
    title: event.title,
    description: event.description ?? "",
    startAt: toDateTimeLocalValue(event.start_at),
    endAt: toDateTimeLocalValue(event.end_at),
    color: event.color_class === "or" ? "a" : event.color_class,
  };
}

function eventOverlapsRange(event: Pick<ScheduleEvent, "start_at" | "end_at">, range: { start: Date; end: Date }): boolean {
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return start < range.end && end > range.start;
}

function cachedRangeCoversView(row: { range_start: string; range_end: string }, range: { start: Date; end: Date }): boolean {
  const start = new Date(row.range_start);
  const end = new Date(row.range_end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return start <= range.start && end >= range.end;
}

function sourceLabel(source?: string): string {
  if (source === "google") return "Google Calendar";
  if (source === "outlook") return "Outlook";
  return "Schedule";
}

function formatEventWindow(event: ScheduleEvent): string {
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Time unavailable";
  if (event.all_day) {
    return `All day · ${start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
  }
  const startText = start.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const endText = start.toDateString() === end.toDateString()
    ? end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : end.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${startText} – ${endText}`;
}

function makeSeedEvents(): Omit<ScheduleEvent, "id">[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return [
    {
      title: "Zone-2 Run · 8 km",
      start_at: new Date(y, m, d, 7, 0).toISOString(),
      end_at: new Date(y, m, d, 8, 0).toISOString(),
      color_class: "b",
    },
    {
      title: "DBS Manuscript — Discussion",
      start_at: new Date(y, m, d, 9, 30).toISOString(),
      end_at: new Date(y, m, d, 11, 30).toISOString(),
      color_class: "a",
    },
    {
      title: "Lab Meeting · Dr. Adeyemi",
      start_at: new Date(y, m, d, 12, 0).toISOString(),
      end_at: new Date(y, m, d, 13, 0).toISOString(),
      color_class: "c",
    },
  ];
}

export function ScheduleModule() {
  const supabase = useMemo(() => createClient(), []);
  const { toast } = useToast();
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    date: new Date().toISOString().slice(0, 10),
    startHour: "9",
    endHour: "10",
    color: "a" as LocalColor,
    recurrence: "none" as "none" | "daily" | "weekly",
  });
  const [view, setView] = useState<"week" | "month" | "day">("week");
  const [signedIn, setSignedIn] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ScheduleEvent | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>("view");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editForm, setEditForm] = useState<EventEditForm>({
    title: "",
    description: "",
    startAt: "",
    endAt: "",
    color: "a",
  });
  const [savingDetail, setSavingDetail] = useState(false);
  const [deletingDetail, setDeletingDetail] = useState(false);
  const [calStatus, setCalStatus] = useState<CalendarStatusResponse | null>(null);
  const [composioCal, setComposioCal] = useState<{ google: ComposioCalState; outlook: ComposioCalState }>({
    google: { active: false, email: null },
    outlook: { active: false, email: null },
  });
  const [showCalPicker, setShowCalPicker] = useState(false);
  const calBtnRef = useRef<HTMLDivElement>(null);
  const [externalEvents, setExternalEvents] = useState<ScheduleEvent[]>([]);
  const [externalNotice, setExternalNotice] = useState<string | null>(null);
  const [externalFetchedAt, setExternalFetchedAt] = useState<string | null>(null);
  const [externalFromCache, setExternalFromCache] = useState(false);

  const refreshComposioCalStatus = useCallback(() => {
    fetch("/api/integrations/composio/status")
      .then((r) => r.json())
      .then((d: { connections?: Array<{ toolkit: string; status: string; account_label: string | null }> }) => {
        const conns = d.connections ?? [];
        const g = conns.find((c) => c.toolkit === "googlecalendar" && c.status === "ACTIVE");
        const o = conns.find((c) => c.toolkit === "outlook" && c.status === "ACTIVE");
        setComposioCal({
          google: { active: !!g, email: g?.account_label ?? null },
          outlook: { active: !!o, email: o?.account_label ?? null },
        });
      })
      .catch(() => {});
  }, []);

  // Close calendar picker on outside click
  useEffect(() => {
    if (!showCalPicker) return;
    const handler = (e: MouseEvent) => {
      if (calBtnRef.current && !calBtnRef.current.contains(e.target as Node)) setShowCalPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showCalPicker]);

  // Anchor date for navigation — prev/next shifts it by the active view's unit.
  const [anchor, setAnchor] = useState(() => new Date());
  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  // Index (Mon=0) of today within the anchored week — only ≥0 when that week
  // actually contains today, so the highlight disappears on other weeks.
  const todayIdx = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - weekStart.getTime()) / 86400000);
    return diff >= 0 && diff < 7 ? diff : -1;
  }, [weekStart]);

  // The date range the active view spans — drives both the Supabase query and
  // the external-calendar fetch, so navigating to another week/month pulls that
  // period's events instead of only the current week's.
  const range = useMemo(() => {
    if (view === "month") {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const offset = (first.getDay() + 6) % 7;
      const start = addDays(first, -offset);
      return { start, end: addDays(start, 42) }; // 6-week grid
    }
    if (view === "day") {
      const start = new Date(anchor); start.setHours(0, 0, 0, 0);
      return { start, end: addDays(start, 1) };
    }
    return { start: weekStart, end: addDays(weekStart, 7) };
  }, [view, anchor, weekStart]);

  const shiftPeriod = useCallback((dir: -1 | 1) => {
    setAnchor((d) => {
      if (view === "month") return new Date(d.getFullYear(), d.getMonth() + dir, Math.min(d.getDate(), 28));
      if (view === "day") return addDays(d, dir);
      return addDays(d, dir * 7);
    });
  }, [view]);

  const periodLabel = useMemo(() => {
    if (view === "month") return anchor.toLocaleDateString([], { month: "long", year: "numeric" });
    if (view === "day") return anchor.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    const we = addDays(weekStart, 6);
    return `${weekStart.toLocaleDateString([], { month: "short", day: "numeric" })} – ${we.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  }, [view, anchor, weekStart]);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      // Demo mode only — signed-in users always see their real (possibly empty) week
      setSignedIn(false);
      setEvents(makeSeedEvents().map((e, i) => ({ ...e, id: `seed-${i}` })));
      setLoading(false);
      return;
    }
    setSignedIn(true);

    const { data, error } = await supabase
      .from("schedule_events")
      .select("*")
      .eq("user_id", user.id)
      .gte("start_at", range.start.toISOString())
      .lt("start_at", range.end.toISOString())
      .order("start_at");

    if (error) toast(error.message, "error", "Schedule");
    setEvents(
      (data ?? []).map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        start_at: e.start_at,
        end_at: e.end_at,
        color_class: (e.color_class as "a" | "b" | "c") || "a",
        all_day: e.all_day,
      })),
    );
    setLoading(false);
  }, [supabase, toast, range]);

  useEffect(() => {
    load();
    fetch("/api/calendar/status")
      .then(async (r) => {
        const s = (await r.json().catch(() => ({}))) as Partial<CalendarStatusResponse>;
        if (!r.ok) throw new Error(s.error ?? "Calendar status could not be refreshed.");
        return s as CalendarStatusResponse;
      })
      .then((s) => setCalStatus(s))
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Calendar status could not be refreshed.";
        setExternalNotice(message);
        toast(message, "error", "Schedule");
      });
    refreshComposioCalStatus();
  }, [load, refreshComposioCalStatus, toast]);

  const hasGoogle = !!calStatus?.google || composioCal.google.active;
  const hasOutlook = !!calStatus?.outlook || composioCal.outlook.active;

  // CAL-3 cache-first paint: read the last-known external events straight from
  // calendar_event_cache (RLS-scoped to this user) so the Schedule shows real
  // content immediately, before the live /api/calendar/external round-trip
  // resolves. Read-once per connection state change — the live fetch below
  // (and its cache write-through server-side) is what keeps it current.
  useEffect(() => {
    if (!hasGoogle && !hasOutlook) return;
    let cancelled = false;
    supabase
      .from("calendar_event_cache")
      .select("source, events, fetched_at, range_start, range_end")
      .then(({ data: rows }) => {
        if (cancelled) return;
        type CachedExternalEvent = {
          externalId: string; title: string; start_at: string; end_at: string;
          description?: string | null; location?: string | null; attendees?: string[]; all_day: boolean;
        };
        const cached: ScheduleEvent[] = [];
        let newestFetchedAt: string | null = null;
        for (const row of rows as Array<{ source: "google" | "outlook"; events: CachedExternalEvent[]; fetched_at: string; range_start: string; range_end: string }>) {
          if ((row.source === "google" && !hasGoogle) || (row.source === "outlook" && !hasOutlook)) continue;
          if (!cachedRangeCoversView(row, range)) continue;
          for (const e of row.events ?? []) {
            const cachedEvent = {
              id: `ext-${row.source}-${e.externalId}`,
              title: e.title,
              description: e.description ?? null,
              location: e.location ?? null,
              attendees: e.attendees ?? [],
              start_at: e.start_at,
              end_at: e.end_at,
              color_class: "or" as const,
              all_day: e.all_day,
              source: row.source,
            };
            if (eventOverlapsRange(cachedEvent, range)) cached.push(cachedEvent);
          }
          if (!newestFetchedAt || row.fetched_at > newestFetchedAt) newestFetchedAt = row.fetched_at;
        }
        setExternalEvents(cached);
        if (cached.length > 0) {
          setExternalFetchedAt(newestFetchedAt);
          setExternalFromCache(true);
        } else {
          setExternalFetchedAt(null);
          setExternalFromCache(false);
        }
      });
    return () => { cancelled = true; };
  }, [supabase, hasGoogle, hasOutlook, range]);

  // Pull real events from connected Google/Outlook calendars (read-only — never
  // written to schedule_events) so connecting a provider surfaces actual content,
  // not just a connected badge. Re-fetches whenever a provider connects/disconnects
  // (legacy direct-OAuth or Composio), and is re-callable from the notice's
  // Retry button (CAL-5). Revalidates in the background over whatever the
  // cache-first effect above already painted.
  const fetchExternalEvents = useCallback(() => {
    if (!hasGoogle && !hasOutlook) {
      setExternalEvents([]);
      setExternalNotice(null);
      setExternalFetchedAt(null);
      setExternalFromCache(false);
      return;
    }
    fetch(`/api/calendar/external?start=${range.start.toISOString()}&end=${range.end.toISOString()}`)
      .then((r) => r.json())
      .then((data: {
        events?: Array<{
          externalId: string;
          title: string;
          start_at: string;
          end_at: string;
          description?: string | null;
          location?: string | null;
          attendees?: string[];
          all_day: boolean;
          source: "google" | "outlook";
        }>;
        partial?: boolean;
        errors?: Array<{ source: "google" | "outlook"; message: string }>;
      }) => {
        const fresh = (data.events ?? [])
          .map((e) => ({
            id: `ext-${e.source}-${e.externalId}`,
            title: e.title,
            description: e.description ?? null,
            location: e.location ?? null,
            attendees: e.attendees ?? [],
            start_at: e.start_at,
            end_at: e.end_at,
            color_class: "or" as const,
            all_day: e.all_day,
            source: e.source,
          }))
          .filter((event) => eventOverlapsRange(event, range));
        const failedSources = new Set<string>((data.errors ?? []).map((e) => e.source));
        // A source that failed to revalidate keeps its last-known (cached)
        // events instead of being wiped to empty — matches the server's
        // write-through behavior of never overwriting cache on error.
        setExternalEvents((prev) => [
          ...fresh,
          ...prev.filter((e) =>
            e.source
            && failedSources.has(e.source)
            && eventOverlapsRange(e, range)
            && !fresh.some((f) => f.source === e.source && f.id === e.id),
          ),
        ]);
        setExternalFetchedAt(new Date().toISOString());
        setExternalFromCache(false);
        if (data.partial && data.errors?.length) {
          const sources = [...new Set(data.errors.map((e) => e.source === "google" ? "Google" : "Outlook"))].join(" and ");
          setExternalNotice(`${sources} calendar refresh failed — showing available events.`);
        } else {
          setExternalNotice(null);
        }
      })
      .catch(() => {
        setExternalEvents((prev) => prev.filter((event) => eventOverlapsRange(event, range)));
        setExternalNotice("External calendars could not refresh — showing last loaded events.");
      });
  }, [hasGoogle, hasOutlook, range]);

  useEffect(() => {
    fetchExternalEvents();
  }, [fetchExternalEvents]);

  const displayEvents = useMemo(() => [...events, ...externalEvents], [events, externalEvents]);

  const openEventDetail = useCallback((event: ScheduleEvent) => {
    setSelectedEvent(event);
    setDetailMode("view");
    setConfirmingDelete(false);
    setEditForm(eventToEditForm(event));
  }, []);

  const monthCells = useMemo(() => {
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // weeks start Monday
    const gridStart = addDays(first, -offset);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const weeks = Math.ceil((offset + daysInMonth) / 7);
    const todayKey = new Date().toDateString();

    return Array.from({ length: weeks * 7 }, (_, i) => {
      const date = addDays(gridStart, i);
      const out = date.getMonth() !== month;
      const chips: EventChip[] = [];
      if (!out && !signedIn) chips.push(...(MONTH_SAMPLE_EVENTS[date.getDate()] ?? []));
      for (const ev of displayEvents) {
        if (new Date(ev.start_at).toDateString() === date.toDateString()) {
          chips.push({ cls: ev.color_class, title: ev.title, event: ev });
        }
      }
      return {
        key: date.toISOString(),
        day: date.getDate(),
        out,
        isToday: date.toDateString() === todayKey,
        chips: chips.slice(0, 3),
      };
    });
  }, [displayEvents, signedIn, anchor]);

  const dayRows = useMemo(() => {
    const now = new Date();
    const dayKey = anchor.toDateString();
    const rows = displayEvents
      .filter((ev) => new Date(ev.start_at).toDateString() === dayKey)
      .sort((a, b) => a.start_at.localeCompare(b.start_at))
      .map((ev) => {
        const start = new Date(ev.start_at);
        const end = new Date(ev.end_at);
        return {
          time: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
          title: ev.title,
          now: start <= now && now < end,
          event: ev,
        };
      });
    if (rows.length) return rows;
    // Demo-mode sample only when viewing *today* and signed out.
    return signedIn || dayKey !== now.toDateString() ? [] : DAY_SAMPLE_ROWS;
  }, [displayEvents, signedIn, anchor]);

  // Precomputed day+hour -> events lookup, built once per displayEvents/weekStart
  // change instead of re-filtering the full events array per grid cell render.
  const slotMap = useMemo(() => {
    const map = new Map<string, ScheduleEvent[]>();
    for (let dayIdx = 0; dayIdx < DAYS.length; dayIdx++) {
      const day = addDays(weekStart, dayIdx);
      for (const hour of HOURS) {
        const slotStart = new Date(day);
        slotStart.setHours(hour, 0, 0, 0);
        const slotEnd = new Date(day);
        slotEnd.setHours(hour + 1, 0, 0, 0);
        const slotEvents = displayEvents.filter((ev) => {
          const start = new Date(ev.start_at);
          const end = new Date(ev.end_at);
          return start < slotEnd && end > slotStart;
        });
        map.set(`${dayIdx}-${hour}`, slotEvents);
      }
    }
    return map;
  }, [displayEvents, weekStart]);

  const eventsForSlot = useCallback(
    (dayIdx: number, hour: number) => slotMap.get(`${dayIdx}-${hour}`) ?? [],
    [slotMap],
  );

  const saveEvent = async () => {
    if (!form.title.trim()) {
      toast("Give the event a title.", "warn", "Schedule");
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast("Sign in to save events to Supabase.", "warn", "Schedule");
      return;
    }

    const start = new Date(`${form.date}T${form.startHour.padStart(2, "0")}:00:00`);
    const end = new Date(`${form.date}T${form.endHour.padStart(2, "0")}:00:00`);
    if (end <= start) {
      toast("End time must be after start time.", "warn", "Schedule");
      return;
    }

    const recurrenceRule = form.recurrence !== "none" ? form.recurrence : null;

    // Build base insert; for recurring events also insert the next N instances
    const instances: Array<{ user_id: string; title: string; start_at: string; end_at: string; color_class: string; recurrence_rule: string | null }> = [];
    const duration = end.getTime() - start.getTime();
    const repeatCount = form.recurrence === "daily" ? 6 : form.recurrence === "weekly" ? 3 : 0;
    for (let i = 0; i <= repeatCount; i++) {
      const offset = form.recurrence === "daily" ? i : i * 7;
      const s = new Date(start.getTime() + offset * 24 * 60 * 60 * 1000);
      const e = new Date(s.getTime() + duration);
      instances.push({
        user_id: user.id,
        title: form.title,
        start_at: s.toISOString(),
        end_at: e.toISOString(),
        color_class: form.color,
        recurrence_rule: recurrenceRule,
      });
    }

    const { data: inserted, error } = await supabase
      .from("schedule_events")
      .insert(instances)
      .select("id")
      .limit(1)
      .single();

    if (error) { toast(error.message, "error", "Schedule"); return; }

    const label = form.recurrence === "none" ? "Event added." : `Event added (${repeatCount + 1} instances — ${form.recurrence}).`;
    toast(label, "success", "Schedule");
    setModalOpen(false);
    setForm({ title: "", date: new Date().toISOString().slice(0, 10), startHour: "9", endHour: "10", color: "a", recurrence: "none" });
    load();

    // Sync to connected external calendars
    if (inserted && (hasGoogle || hasOutlook)) {
      fetch("/api/calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: inserted.id, title: form.title, start_at: start.toISOString(), end_at: end.toISOString() }),
      })
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.partial) toast("Event saved, but calendar sync was partial.", "warn", "Schedule");
        })
        .catch(() => { toast("Event saved, but calendar sync failed.", "warn", "Schedule"); });
    }

    // Context-aware conflict check — reads local + (if connected) Google
    // Calendar state at save time and suggests an alternative if it overlaps.
    // Only checks the first instance of a recurring series, not every
    // generated occurrence — a single heads-up toast is enough signal.
    if (inserted) {
      fetch("/api/calendar/conflicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_at: start.toISOString(), end_at: end.toISOString(), excludeEventId: inserted.id }),
      })
        .then((r) => r.json())
        .then((data: { conflict?: boolean; conflictingTitles?: string[]; suggestions?: Array<{ start_at: string; end_at: string }>; partial?: boolean }) => {
          if (data.partial) toast("External conflict check was unavailable.", "warn", "Schedule");
          if (!data.conflict) return;
          const withWhat = data.conflictingTitles?.length ? ` with ${data.conflictingTitles.join(", ")}` : "";
          const next = data.suggestions?.[0];
          const suggestionText = next
            ? ` Free slot: ${new Date(next.start_at).toLocaleString("en-GB", { weekday: "short", hour: "numeric", minute: "2-digit" })}–${new Date(next.end_at).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })}.`
            : "";
          toast(`Heads up — this overlaps${withWhat}.${suggestionText}`, "warn", "Schedule");
        })
        .catch(() => {});
    }
  };

  const updateSelectedEvent = async () => {
    if (!selectedEvent || selectedEvent.source || selectedEvent.id.startsWith("seed-")) return;
    const title = editForm.title.trim();
    if (!title) {
      toast("Give the event a title.", "warn", "Schedule");
      return;
    }
    const start = new Date(editForm.startAt);
    const end = new Date(editForm.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      toast("Choose a valid start and end time.", "warn", "Schedule");
      return;
    }
    if (end <= start) {
      toast("End time must be after start time.", "warn", "Schedule");
      return;
    }

    setSavingDetail(true);
    try {
      const response = await fetch(`/api/calendar/event/${encodeURIComponent(selectedEvent.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: editForm.description.trim() || null,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          color_class: editForm.color,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        event?: ScheduleEvent;
        error?: string;
        partial?: boolean;
        notSupported?: Array<"google" | "outlook">;
      };
      if (!response.ok || !payload.event) {
        throw new Error(payload.error || "Could not update event.");
      }

      const updated: ScheduleEvent = {
        ...payload.event,
        color_class: payload.event.color_class === "or" ? "a" : payload.event.color_class,
      };
      setEvents((current) => current.map((event) => (event.id === updated.id ? updated : event)));
      setSelectedEvent(updated);
      setEditForm(eventToEditForm(updated));
      setDetailMode("view");
      if (payload.partial) {
        toast("Event updated locally, but syncing the change to your calendar failed.", "warn", "Schedule");
      } else if (payload.notSupported?.length) {
        const providers = payload.notSupported.map((p) => (p === "google" ? "Google Calendar" : "Outlook")).join(" and ");
        toast(`Event updated locally. ${providers} sync via Composio doesn't support edits yet — update it there manually.`, "warn", "Schedule");
      } else {
        toast("Event updated.", "success", "Schedule");
      }
      load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update event.", "error", "Schedule");
    } finally {
      setSavingDetail(false);
    }
  };

  const deleteSelectedEvent = async () => {
    if (!selectedEvent || selectedEvent.source) return;
    setDeletingDetail(true);
    try {
      if (selectedEvent.id.startsWith("seed-")) {
        setEvents((current) => current.filter((event) => event.id !== selectedEvent.id));
        toast("Sample event removed.", "info", "Schedule");
      } else {
        const response = await fetch(`/api/calendar/event/${encodeURIComponent(selectedEvent.id)}`, { method: "DELETE" });
        const payload = (await response.json().catch(() => ({}))) as { error?: string; calendarCleanupFailed?: boolean };
        if (!response.ok) throw new Error(payload.error || "Could not delete event.");

        setEvents((current) => current.filter((event) => event.id !== selectedEvent.id));
        toast(
          payload.calendarCleanupFailed
            ? "Event removed locally, but calendar cleanup failed."
            : "Event removed.",
          payload.calendarCleanupFailed ? "warn" : "info",
          "Schedule",
        );
        load();
      }
      setSelectedEvent(null);
      setConfirmingDelete(false);
      setDetailMode("view");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not delete event.", "error", "Schedule");
    } finally {
      setDeletingDetail(false);
    }
  };

  const selectedCanEdit = !!selectedEvent && !selectedEvent.source && !selectedEvent.id.startsWith("seed-");
  const selectedCanDelete = !!selectedEvent && !selectedEvent.source;
  const selectedAttendees = selectedEvent?.attendees?.filter(Boolean) ?? [];

  if (loading) return <div className="empty-state">Loading schedule…</div>;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        {/* Google Calendar — connected via legacy direct-OAuth or Composio */}
        {calStatus?.google ? (
          <button
            type="button"
            className="selectbox"
            style={{ background: "none", color: "var(--up)" }}
            onClick={async () => {
              await fetch("/api/calendar/disconnect?provider=google", { method: "DELETE" });
              setCalStatus((s) => s ? { ...s, google: false, googleEmail: null } : s);
              toast("Google Calendar disconnected", "info", "Schedule");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            {calStatus.googleEmail ?? "Google Calendar"} ✓
          </button>
        ) : composioCal.google.active ? (
          <button
            type="button"
            className="selectbox"
            style={{ background: "none", color: "var(--up)" }}
            onClick={async () => {
              await fetch("/api/integrations/composio/disconnect?toolkit=googlecalendar", { method: "DELETE" });
              setComposioCal((s) => ({ ...s, google: { active: false, email: null } }));
              toast("Google Calendar disconnected", "info", "Schedule");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            {composioCal.google.email ?? "Google Calendar"} ✓
          </button>
        ) : null}
        {/* Outlook Calendar — connected via legacy direct-OAuth or Composio */}
        {calStatus?.outlook ? (
          <button
            type="button"
            className="selectbox"
            style={{ background: "none", color: "var(--up)" }}
            onClick={async () => {
              await fetch("/api/calendar/disconnect?provider=outlook", { method: "DELETE" });
              setCalStatus((s) => s ? { ...s, outlook: false, outlookEmail: null } : s);
              toast("Outlook Calendar disconnected", "info", "Schedule");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            {calStatus.outlookEmail ?? "Outlook"} ✓
          </button>
        ) : composioCal.outlook.active ? (
          <button
            type="button"
            className="selectbox"
            style={{ background: "none", color: "var(--up)" }}
            onClick={async () => {
              await fetch("/api/integrations/composio/disconnect?toolkit=outlook", { method: "DELETE" });
              setComposioCal((s) => ({ ...s, outlook: { active: false, email: null } }));
              toast("Outlook Calendar disconnected", "info", "Schedule");
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            {composioCal.outlook.email ?? "Outlook"} ✓
          </button>
        ) : null}
        <div ref={calBtnRef} style={{ position: "relative" }}>
          <div className="selectbox" style={{ cursor: "pointer" }} onClick={() => setShowCalPicker((v) => !v)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            Connect Calendar
          </div>
          {showCalPicker && (
            <AddCalendarPicker
              onClose={() => setShowCalPicker(false)}
              onConnected={(provider) => {
                toast(`${provider === "google" ? "Google" : "Outlook"} Calendar connected`, "success", "Schedule");
                fetch("/api/calendar/status")
                  .then(async (r) => {
                    const s = (await r.json().catch(() => ({}))) as Partial<CalendarStatusResponse>;
                    if (!r.ok) throw new Error(s.error ?? "Calendar status could not be refreshed.");
                    return s as CalendarStatusResponse;
                  })
                  .then((s) => {
                    setCalStatus(s);
                    setExternalNotice(null);
                  })
                  .catch((error) => {
                    const message = error instanceof Error ? error.message : "Calendar status could not be refreshed.";
                    setExternalNotice(message);
                    toast(message, "error", "Schedule");
                  });
                refreshComposioCalStatus();
              }}
            />
          )}
        </div>
        {/* Period navigation — prev / next shift by the active view's unit. */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" className="selectbox" style={{ padding: "4px 9px", cursor: "pointer" }} onClick={() => shiftPeriod(-1)} aria-label="Previous">‹</button>
          <span style={{ minWidth: 132, textAlign: "center", fontSize: 12, fontFamily: "var(--narrow)", color: "var(--ink-dim)", letterSpacing: ".02em" }}>{periodLabel}</span>
          <button type="button" className="selectbox" style={{ padding: "4px 9px", cursor: "pointer" }} onClick={() => shiftPeriod(1)} aria-label="Next">›</button>
          <button type="button" className="selectbox" style={{ padding: "4px 10px", cursor: "pointer", fontSize: 11 }} onClick={() => setAnchor(new Date())}>Today</button>
        </div>
        <div className="vtoggle">
          <button type="button" className={view === "week" ? "on" : ""} onClick={() => setView("week")}>WEEK</button>
          <button type="button" className={view === "month" ? "on" : ""} onClick={() => setView("month")}>MONTH</button>
          <button type="button" className={view === "day" ? "on" : ""} onClick={() => setView("day")}>DAY</button>
        </div>
      </div>

      {externalNotice && (
        <p style={{ margin: "0 0 4px", fontSize: 11, color: "var(--clay)", display: "flex", alignItems: "center", gap: 8 }}>
          {externalNotice}
          <button
            type="button"
            onClick={fetchExternalEvents}
            style={{ background: "none", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}
          >
            Retry
          </button>
        </p>
      )}
      {(hasGoogle || hasOutlook) && externalFetchedAt && (
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--ink-faint)" }}>
          {formatCalendarFreshness(externalFetchedAt, externalFromCache)}
        </p>
      )}

      {view === "month" ? (
        <div className="cal">
          <div className="cal-hd">
            {DAYS.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="cal-body">
            {monthCells.map((cell) => (
              <div
                key={cell.key}
                className={`cell${cell.out ? " out" : ""}${cell.isToday ? " today" : ""}`}
              >
                <div className="dn">{cell.day}</div>
                {cell.chips.map((chip, i) => (
                  <div
                    key={`${cell.key}-${i}`}
                    className={`ev ${chip.cls}`}
                    title={chip.event ? `${chip.title} — open details` : chip.title}
                    role={chip.event ? "button" : undefined}
                    tabIndex={chip.event ? 0 : undefined}
                    onClick={() => chip.event && openEventDetail(chip.event)}
                    onKeyDown={(e) => {
                      if (!chip.event || (e.key !== "Enter" && e.key !== " ")) return;
                      e.preventDefault();
                      openEventDetail(chip.event);
                    }}
                  >
                    {chip.title}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : view === "day" ? (
        <Card tick style={{ maxWidth: "min(600px, 92vw)" }}>
          <h2 className="sec">
            {anchor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
            <span className="rule" />
          </h2>
          <div style={{ marginTop: 14 }}>
            {dayRows.length === 0 ? (
              <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>Nothing scheduled for this day.</p>
            ) : (
              dayRows.map((row) => (
                <div
                  key={`${row.time}-${row.title}`}
                  className="tl-item"
                  role={row.event ? "button" : undefined}
                  tabIndex={row.event ? 0 : undefined}
                  style={row.event ? { cursor: "pointer" } : undefined}
                  onClick={() => row.event && openEventDetail(row.event)}
                  onKeyDown={(e) => {
                    if (!row.event || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    openEventDetail(row.event);
                  }}
                >
                  <div className="tl-time">{row.time}</div>
                  <div className={`tl-body${row.now ? " now" : ""}`}>
                    <div className="tl-title">{row.title}</div>
                  </div>
                  <div />
                </div>
              ))
            )}
          </div>
        </Card>
      ) : displayEvents.length === 0 ? (
        <Card>
          <div className="empty-state">
            <strong>No events this week</strong>
            <p>Connect Google Calendar or Outlook to sync your schedule, or add an event above.</p>
          </div>
        </Card>
      ) : (
        <div className="wk" style={{ overflowX: "auto" }}>
          <div className="wkh" />
          {DAYS.map((d, i) => (
            <div key={d} className={`wkh ${i === todayIdx ? "today" : ""}`}>
              {d}
            </div>
          ))}
          {HOURS.map((hour) => (
            <div key={`row-${hour}`} className="contents">
              <div className="hr">{hourLabel(hour)}</div>
              {DAYS.map((_, dayIdx) => {
                const slotEvents = eventsForSlot(dayIdx, hour);
                return (
                  <div key={`${dayIdx}-${hour}`} className="slot">
                    {slotEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className={`wkev ${ev.color_class}`}
                        title={ev.source ? `${ev.title} — synced from ${sourceLabel(ev.source)}` : `${ev.title} — open details`}
                        onClick={() => openEventDetail(ev)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          openEventDetail(ev);
                        }}
                      >
                        {ev.title}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className="divider" />
      <Card style={{ maxWidth: "min(560px, 92vw)" }}>
        <div className="seclabel">Add to Schedule</div>
        <div className="capture" style={{ margin: "0 0 12px", padding: "11px 14px" }}>
          <input placeholder="Spanish lesson, 25 min, every weekday morning" style={{ padding: "3px 0", color: "var(--ink)" }} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="capt-pill">⤳ Repeat: Daily</span>
          <span className="capt-pill">⤳ Weekly</span>
          <span className="capt-pill">⌁ Let AI Find a Slot</span>
          <button type="button" className="capt-go" onClick={() => setModalOpen(true)}>+ Add event</button>
        </div>
      </Card>
      <p style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)" }}>
        Click an event to manage it.
      </p>

      <Modal
        open={!!selectedEvent}
        onClose={() => {
          setSelectedEvent(null);
          setConfirmingDelete(false);
          setDetailMode("view");
        }}
        title="Event detail"
        footer={
          selectedEvent ? (
            confirmingDelete ? (
              <>
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={deletingDetail}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={deleteSelectedEvent} loading={deletingDetail}>
                  Remove
                </Button>
              </>
            ) : detailMode === "edit" && selectedCanEdit ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditForm(eventToEditForm(selectedEvent));
                    setDetailMode("view");
                  }}
                  disabled={savingDetail}
                >
                  Cancel
                </Button>
                <Button variant="primary" onClick={updateSelectedEvent} loading={savingDetail}>
                  Save changes
                </Button>
              </>
            ) : (
              <>
                {selectedCanDelete && (
                  <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
                    Delete
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSelectedEvent(null);
                    setConfirmingDelete(false);
                  }}
                >
                  Close
                </Button>
                {selectedCanEdit && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setEditForm(eventToEditForm(selectedEvent));
                      setDetailMode("edit");
                    }}
                  >
                    Edit
                  </Button>
                )}
              </>
            )
          ) : null
        }
      >
        {selectedEvent && detailMode === "edit" && selectedCanEdit ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
              Title
              <input
                className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--ink)]"
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
                Starts
                <input
                  type="datetime-local"
                  className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--ink)]"
                  value={editForm.startAt}
                  onChange={(e) => setEditForm({ ...editForm, startAt: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
                Ends
                <input
                  type="datetime-local"
                  className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--ink)]"
                  value={editForm.endAt}
                  onChange={(e) => setEditForm({ ...editForm, endAt: e.target.value })}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
              Description
              <textarea
                className="min-h-24 rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm normal-case tracking-normal text-[var(--ink)]"
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-faint)]">
              Color
              <select
                className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-2 py-2 text-sm normal-case tracking-normal text-[var(--ink)]"
                value={editForm.color}
                onChange={(e) => setEditForm({ ...editForm, color: e.target.value as LocalColor })}
              >
                {COLOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : selectedEvent ? (
          <div className="flex flex-col gap-4 text-sm">
            <div>
              <div className="seclabel">{sourceLabel(selectedEvent.source)}</div>
              <h3 style={{ marginTop: 6, fontSize: 18, color: "var(--ink)" }}>{selectedEvent.title}</h3>
              <p style={{ marginTop: 4, color: "var(--ink-dim)" }}>{formatEventWindow(selectedEvent)}</p>
            </div>
            {selectedEvent.source ? (
              <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                Synced from {sourceLabel(selectedEvent.source)}. Provider events are read-only here.
              </p>
            ) : selectedEvent.id.startsWith("seed-") ? (
              <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                Sample event. Sign in to save schedule changes to Supabase.
              </p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <div className="seclabel">Location</div>
                <div style={{ marginTop: 5, color: "var(--ink)" }}>{selectedEvent.location || "Not set"}</div>
              </div>
              <div className="rounded border border-[var(--line)] bg-[var(--surface-2)] p-3">
                <div className="seclabel">Attendees</div>
                <div style={{ marginTop: 5, color: "var(--ink)" }}>
                  {selectedAttendees.length ? selectedAttendees.slice(0, 4).join(", ") : "None"}
                  {selectedAttendees.length > 4 ? ` +${selectedAttendees.length - 4}` : ""}
                </div>
              </div>
            </div>
            <div>
              <div className="seclabel">Description</div>
              <p style={{ marginTop: 6, whiteSpace: "pre-wrap", color: selectedEvent.description ? "var(--ink)" : "var(--ink-faint)" }}>
                {selectedEvent.description || "No description."}
              </p>
            </div>
            {confirmingDelete && (
              <div
                role="alert"
                className="rounded border border-[var(--down)] bg-[rgba(255,107,107,0.08)] p-3"
                style={{ color: "var(--ink-dim)", fontSize: 13 }}
              >
                Remove <strong style={{ color: "var(--ink)" }}>{selectedEvent.title}</strong> from your schedule?
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add to Schedule"
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveEvent}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
            placeholder="Event title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            type="date"
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
          <div className="flex gap-2">
            <select
              className="flex-1 rounded border border-[var(--line)] bg-[var(--surface-2)] px-2 py-2 text-sm"
              value={form.startHour}
              onChange={(e) => setForm({ ...form, startHour: e.target.value })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  Start {hourLabel(h)}
                </option>
              ))}
            </select>
            <select
              className="flex-1 rounded border border-[var(--line)] bg-[var(--surface-2)] px-2 py-2 text-sm"
              value={form.endHour}
              onChange={(e) => setForm({ ...form, endHour: e.target.value })}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  End {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <select
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-2 py-2 text-sm"
            value={form.color}
            onChange={(e) =>
              setForm({ ...form, color: e.target.value as "a" | "b" | "c" })
            }
          >
            <option value="a">Teal — Deep work</option>
            <option value="b">Green — Wellness</option>
            <option value="c">Clay — Meetings</option>
          </select>
          <select
            className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-2 py-2 text-sm"
            value={form.recurrence}
            onChange={(e) =>
              setForm({ ...form, recurrence: e.target.value as "none" | "daily" | "weekly" })
            }
          >
            <option value="none">No repeat</option>
            <option value="daily">Daily — next 7 days</option>
            <option value="weekly">Weekly — next 4 weeks</option>
          </select>
        </div>
      </Modal>
    </>
  );
}
