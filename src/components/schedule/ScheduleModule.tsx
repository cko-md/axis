"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hourLabel } from "@/lib/format";
import type { ScheduleEvent } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type ChipColor = "a" | "b" | "c";

// Static sample chips sprinkled on fixed days of the current month (Phase-3 stub).
const MONTH_SAMPLE_EVENTS: Record<number, Array<{ cls: ChipColor; title: string }>> = {
  3: [{ cls: "a", title: "Deep Work" }],
  8: [{ cls: "b", title: "Zone-2 Run" }],
  12: [{ cls: "c", title: "Lab Meeting" }],
  18: [{ cls: "a", title: "Manuscript" }],
  24: [{ cls: "b", title: "Long Run" }],
  27: [{ cls: "c", title: "Clinic Review" }],
};

const DAY_SAMPLE_ROWS = [
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
    color: "a" as "a" | "b" | "c",
  });
  const [view, setView] = useState<"week" | "month" | "day">("week");
  const [signedIn, setSignedIn] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScheduleEvent | null>(null);
  const [calStatus, setCalStatus] = useState<{ google: boolean; googleEmail: string | null; outlook: boolean; outlookEmail: string | null } | null>(null);

  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const todayIdx = useMemo(() => {
    const d = new Date().getDay();
    return d === 0 ? 6 : d - 1;
  }, []);

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

    const weekEnd = addDays(weekStart, 7);
    const { data, error } = await supabase
      .from("schedule_events")
      .select("*")
      .eq("user_id", user.id)
      .gte("start_at", weekStart.toISOString())
      .lt("start_at", weekEnd.toISOString())
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
      })),
    );
    setLoading(false);
  }, [supabase, toast, weekStart]);

  useEffect(() => {
    load();
    fetch("/api/calendar/status")
      .then((r) => r.json())
      .then((s) => setCalStatus(s))
      .catch(() => {});
  }, [load]);

  const monthCells = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // weeks start Monday
    const gridStart = addDays(first, -offset);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const weeks = Math.ceil((offset + daysInMonth) / 7);
    const todayKey = now.toDateString();

    return Array.from({ length: weeks * 7 }, (_, i) => {
      const date = addDays(gridStart, i);
      const out = date.getMonth() !== month;
      const chips: Array<{ cls: ChipColor; title: string }> = [];
      if (!out && !signedIn) chips.push(...(MONTH_SAMPLE_EVENTS[date.getDate()] ?? []));
      for (const ev of events) {
        if (new Date(ev.start_at).toDateString() === date.toDateString()) {
          chips.push({ cls: ev.color_class, title: ev.title });
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
  }, [events, signedIn]);

  const dayRows = useMemo(() => {
    const now = new Date();
    const todayKey = now.toDateString();
    const rows = events
      .filter((ev) => new Date(ev.start_at).toDateString() === todayKey)
      .sort((a, b) => a.start_at.localeCompare(b.start_at))
      .map((ev) => {
        const start = new Date(ev.start_at);
        const end = new Date(ev.end_at);
        return {
          time: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
          title: ev.title,
          now: start <= now && now < end,
        };
      });
    if (rows.length) return rows;
    return signedIn ? [] : DAY_SAMPLE_ROWS;
  }, [events, signedIn]);

  const eventsForSlot = (dayIdx: number, hour: number) => {
    const day = addDays(weekStart, dayIdx);
    return events.filter((ev) => {
      const start = new Date(ev.start_at);
      const end = new Date(ev.end_at);
      const slotStart = new Date(day);
      slotStart.setHours(hour, 0, 0, 0);
      const slotEnd = new Date(day);
      slotEnd.setHours(hour + 1, 0, 0, 0);
      return start < slotEnd && end > slotStart;
    });
  };

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

    const { data: inserted, error } = await supabase
      .from("schedule_events")
      .insert({
        user_id: user.id,
        title: form.title,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        color_class: form.color,
      })
      .select("id")
      .single();

    if (error) { toast(error.message, "error", "Schedule"); return; }

    toast("Event added.", "success", "Schedule");
    setModalOpen(false);
    setForm({ title: "", date: new Date().toISOString().slice(0, 10), startHour: "9", endHour: "10", color: "a" });
    load();

    // Fire-and-forget calendar sync if any provider is connected
    if (inserted && (calStatus?.google || calStatus?.outlook)) {
      fetch("/api/calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: inserted.id, title: form.title, start_at: start.toISOString(), end_at: end.toISOString() }),
      }).catch(() => {});
    }
  };

  const deleteEvent = async (id: string) => {
    setPendingDelete(null);
    if (id.startsWith("seed-")) {
      setEvents((e) => e.filter((x) => x.id !== id));
      return;
    }
    // Remove from external calendars before deleting locally
    if (calStatus?.google || calStatus?.outlook) {
      fetch(`/api/calendar/event/${id}`, { method: "DELETE" }).catch(() => {});
    }
    const { error } = await supabase.from("schedule_events").delete().eq("id", id);
    if (error) toast(error.message, "error", "Schedule");
    else toast("Event removed.", "info", "Schedule");
    load();
  };

  if (loading) return <div className="empty-state">Loading schedule…</div>;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        {/* Google Calendar */}
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
        ) : (
          <button
            type="button"
            className="selectbox"
            style={{ background: "none" }}
            onClick={() => { window.location.href = "/api/calendar/connect?provider=google"; }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            Connect Google Calendar
          </button>
        )}
        {/* Outlook Calendar */}
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
        ) : (
          <button
            type="button"
            className="selectbox"
            style={{ background: "none" }}
            onClick={() => { window.location.href = "/api/calendar/connect?provider=outlook"; }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20" /></svg>
            Connect Outlook
          </button>
        )}
        <div className="vtoggle">
          <button type="button" className={view === "week" ? "on" : ""} onClick={() => setView("week")}>WEEK</button>
          <button type="button" className={view === "month" ? "on" : ""} onClick={() => setView("month")}>MONTH</button>
          <button type="button" className={view === "day" ? "on" : ""} onClick={() => setView("day")}>DAY</button>
        </div>
      </div>

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
                  <div key={`${cell.key}-${i}`} className={`ev ${chip.cls}`} title={chip.title}>
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
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
            <span className="rule" />
          </h2>
          <div style={{ marginTop: 14 }}>
            {dayRows.length === 0 ? (
              <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>Nothing scheduled today.</p>
            ) : (
              dayRows.map((row) => (
                <div key={`${row.time}-${row.title}`} className="tl-item">
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
      ) : events.length === 0 ? (
        <Card>
          <div className="empty-state">
            <strong>No events this week</strong>
            <p>Add a block or connect Google Calendar in a future phase.</p>
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
                        title={`${ev.title} — click to manage`}
                        onClick={() => setPendingDelete(ev)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && setPendingDelete(ev)}
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
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Remove event"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => pendingDelete && deleteEvent(pendingDelete.id)}>
              Remove
            </Button>
          </>
        }
      >
        {pendingDelete && (
          <p style={{ fontSize: 13, color: "var(--ink-dim)" }}>
            Remove <strong style={{ color: "var(--ink)" }}>{pendingDelete.title}</strong> (
            {new Date(pendingDelete.start_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
            ) from your schedule?
          </p>
        )}
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
        </div>
      </Modal>
    </>
  );
}
