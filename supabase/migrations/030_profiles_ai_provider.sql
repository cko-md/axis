alter table public.profiles
  add column ai_provider text not null default 'auto'
  check (ai_provider in ('auto', 'gemini', 'anthropic'));
