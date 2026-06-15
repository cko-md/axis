import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const uid = user.id;

  const [{ data: tasks }, { data: notes }, { data: signals }] = await Promise.all([
    supabase.from("agenda_tasks").select("title, priority, due_date, status").eq("user_id", uid).neq("status", "done").limit(30),
    supabase.from("notes").select("title, content").eq("user_id", uid).order("updated_at", { ascending: false }).limit(20),
    supabase.from("signals").select("title, priority, category").eq("user_id", uid).neq("status", "done").limit(20),
  ]);

  const lines = [
    tasks?.length ? `TASKS:\n${tasks.map((t) => `- ${t.title} [${t.priority}]${t.due_date ? ` due ${t.due_date}` : ""}`).join("\n")}` : "",
    notes?.length ? `NOTES:\n${notes.map((n) => `- ${n.title}: ${((n.content as string) ?? "").slice(0, 200)}`).join("\n")}` : "",
    signals?.length ? `SIGNALS:\n${signals.map((s) => `- ${s.title} [${s.category}]`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  if (!lines) return NextResponse.json({ results: [] });

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    messages: [{
      role: "user",
      content: `Analyze this platform content and identify 3–5 high-level objectives the user should be working toward. Return a JSON array only (no explanation): [{target, module, confidence}] where confidence is "high", "medium", or "low" and module is where you found the signal.\n\n${lines}`,
    }],
  });

  try {
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    const results = match ? JSON.parse(match[0]) : [];
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
