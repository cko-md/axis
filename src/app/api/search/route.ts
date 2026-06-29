import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { query?: string };
  const query = body.query?.trim();
  if (!query) return NextResponse.json({ error: 'Missing query' }, { status: 400 });

  // Gather live context from user data
  const [tasksRes, eventsRes, holdingsRes, notesRes] = await Promise.allSettled([
    supabase.from('tasks').select('title, status, priority').eq('user_id', user.id).neq('status', 'done').limit(15),
    supabase.from('schedule_events').select('title, start_time, end_time').eq('user_id', user.id).gte('start_time', new Date().toISOString()).limit(8),
    supabase.from('fund_holdings').select('symbol, name, shares').eq('user_id', user.id).limit(10),
    supabase.from('notes').select('title').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5),
  ]);

  const tasks = tasksRes.status === 'fulfilled' ? (tasksRes.value.data ?? []) : [];
  const events = eventsRes.status === 'fulfilled' ? (eventsRes.value.data ?? []) : [];
  const holdings = holdingsRes.status === 'fulfilled' ? (holdingsRes.value.data ?? []) : [];
  const notes = notesRes.status === 'fulfilled' ? (notesRes.value.data ?? []) : [];

  const ctxParts: string[] = [];
  if (tasks.length) ctxParts.push(`Open tasks: ${tasks.map((t: { title: string; status: string; priority?: string }) => `${t.title} [${t.status}]`).join(', ')}`);
  if (events.length) ctxParts.push(`Upcoming events: ${events.map((e: { title: string; start_time: string }) => `${e.title} (${new Date(e.start_time).toLocaleDateString()})`).join(', ')}`);
  if (holdings.length) ctxParts.push(`Portfolio: ${holdings.map((h: { symbol: string; name: string }) => h.symbol).join(', ')}`);
  if (notes.length) ctxParts.push(`Recent notes: ${notes.map((n: { title: string }) => n.title).join(', ')}`);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 350,
    system: `You are Axis, an AI assistant embedded in a personal operating system for a physician-investor.
Answer questions about the user's data, provide insights, or answer general knowledge questions.
Be concise: 2-4 sentences. Use specific data when available.
User context:
${ctxParts.length ? ctxParts.join('\n') : 'No personal data loaded yet.'}`,
    messages: [{ role: 'user', content: query }],
  });

  const answer = message.content[0].type === 'text' ? message.content[0].text : '';
  return NextResponse.json({ answer });
}
