import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";

export type QuickResult = {
  type: "note" | "task" | "person" | "signal";
  id: string;
  title: string;
  subtitle?: string;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const pattern = `%${q}%`;
  const uid = user.id;

  const [notesRes, tasksRes, peopleRes, signalsRes] = await Promise.allSettled([
    supabase
      .from("notes")
      .select("id, title, folder")
      .eq("user_id", uid)
      .ilike("title", pattern)
      .limit(5),
    supabase
      .from("tasks")
      .select("id, title, status, priority")
      .eq("user_id", uid)
      .ilike("title", pattern)
      .limit(5),
    supabase
      .from("people")
      .select("id, name, role")
      .eq("user_id", uid)
      .ilike("name", pattern)
      .limit(5),
    supabase
      .from("signals")
      .select("id, title, signal_type")
      .eq("user_id", uid)
      .ilike("title", pattern)
      .limit(5),
  ]);

  const results: QuickResult[] = [];
  const failedSources: string[] = [];

  // A per-table failure (rejected promise or a Supabase error payload) must not
  // silently vanish — record it so a partial search is observable, and report
  // it to the client so the UI can say the results are incomplete.
  const noteError = notesRes.status === "fulfilled" ? notesRes.value.error : notesRes.reason;
  if (!noteError && notesRes.status === "fulfilled") {
    for (const n of notesRes.value.data ?? []) {
      results.push({ type: "note", id: n.id, title: n.title || "Untitled", subtitle: n.folder });
    }
  } else if (noteError) failedSources.push("notes");

  const taskError = tasksRes.status === "fulfilled" ? tasksRes.value.error : tasksRes.reason;
  if (!taskError && tasksRes.status === "fulfilled") {
    for (const t of tasksRes.value.data ?? []) {
      results.push({ type: "task", id: t.id, title: t.title, subtitle: `${t.priority ?? ""} · ${t.status}` });
    }
  } else if (taskError) failedSources.push("tasks");

  const peopleError = peopleRes.status === "fulfilled" ? peopleRes.value.error : peopleRes.reason;
  if (!peopleError && peopleRes.status === "fulfilled") {
    for (const p of peopleRes.value.data ?? []) {
      results.push({ type: "person", id: p.id, title: p.name, subtitle: p.role });
    }
  } else if (peopleError) failedSources.push("people");

  const signalError = signalsRes.status === "fulfilled" ? signalsRes.value.error : signalsRes.reason;
  if (!signalError && signalsRes.status === "fulfilled") {
    for (const s of signalsRes.value.data ?? []) {
      results.push({ type: "signal", id: s.id, title: s.title, subtitle: s.signal_type });
    }
  } else if (signalError) failedSources.push("signals");

  if (failedSources.length > 0) {
    // Safe metadata only — table names + query length, never the query text or
    // any row content.
    Sentry.captureMessage("Quick search partial failure", {
      level: "warning",
      tags: { area: "search", op: "quick" },
      extra: { failedSources, queryLength: q.length },
    });
  }

  return NextResponse.json({ results, partial: failedSources.length > 0 });
}
