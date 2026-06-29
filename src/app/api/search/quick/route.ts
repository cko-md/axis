import { NextRequest, NextResponse } from "next/server";
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

  if (notesRes.status === "fulfilled") {
    for (const n of notesRes.value.data ?? []) {
      results.push({ type: "note", id: n.id, title: n.title || "Untitled", subtitle: n.folder });
    }
  }
  if (tasksRes.status === "fulfilled") {
    for (const t of tasksRes.value.data ?? []) {
      results.push({ type: "task", id: t.id, title: t.title, subtitle: `${t.priority ?? ""} · ${t.status}` });
    }
  }
  if (peopleRes.status === "fulfilled") {
    for (const p of peopleRes.value.data ?? []) {
      results.push({ type: "person", id: p.id, title: p.name, subtitle: p.role });
    }
  }
  if (signalsRes.status === "fulfilled") {
    for (const s of signalsRes.value.data ?? []) {
      results.push({ type: "signal", id: s.id, title: s.title, subtitle: s.signal_type });
    }
  }

  return NextResponse.json({ results });
}
