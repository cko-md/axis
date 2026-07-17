-- 039_ai_advisor_tables.sql
-- AI Advisor chat history, granular tool-call trace, and persisted insights
-- (daily brief / weekly recap), replacing the one-shot, non-persisted
-- /api/fund/report pattern. Tool schemas/prompts are Phase 5 — this only
-- creates the tables Phase 5 will read and write.

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_conversations enable row level security;

create policy "ai_conversations_select_own"
  on public.ai_conversations for select using (auth.uid() = user_id);
create policy "ai_conversations_insert_own"
  on public.ai_conversations for insert with check (auth.uid() = user_id);
create policy "ai_conversations_update_own"
  on public.ai_conversations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ai_conversations_delete_own"
  on public.ai_conversations for delete using (auth.uid() = user_id);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);

alter table public.ai_messages enable row level security;

create policy "ai_messages_select_own"
  on public.ai_messages for select using (auth.uid() = user_id);
create policy "ai_messages_insert_own"
  on public.ai_messages for insert with check (auth.uid() = user_id);
create policy "ai_messages_delete_own"
  on public.ai_messages for delete using (auth.uid() = user_id);

create index if not exists idx_ai_messages_conversation on public.ai_messages (conversation_id, created_at);

-- Granular tool-call trace. Kept separate from audit_logs because tool
-- calls are high-volume and advisor-specific (input/output payloads).
create table if not exists public.ai_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.ai_conversations (id) on delete set null,
  tool_name text not null,
  input jsonb,
  output jsonb,
  latency_ms integer,
  created_at timestamptz not null default now()
);

alter table public.ai_tool_calls enable row level security;

create policy "ai_tool_calls_select_own"
  on public.ai_tool_calls for select using (auth.uid() = user_id);
create policy "ai_tool_calls_insert_own"
  on public.ai_tool_calls for insert with check (auth.uid() = user_id);

create index if not exists idx_ai_tool_calls_user_created on public.ai_tool_calls (user_id, created_at desc);

-- Persisted daily brief / weekly recap / anomaly / suggestion records.
create table if not exists public.ai_insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('daily_brief', 'weekly_recap', 'anomaly', 'suggestion')),
  title text not null,
  body text not null,
  data_used jsonb,
  assumptions text,
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  requires_review boolean not null default false,
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.ai_insights enable row level security;

create policy "ai_insights_select_own"
  on public.ai_insights for select using (auth.uid() = user_id);
create policy "ai_insights_insert_own"
  on public.ai_insights for insert with check (auth.uid() = user_id);
create policy "ai_insights_update_own"
  on public.ai_insights for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ai_insights_delete_own"
  on public.ai_insights for delete using (auth.uid() = user_id);

create index if not exists idx_ai_insights_user_kind on public.ai_insights (user_id, kind, created_at desc);
