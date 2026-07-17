-- Default ai_provider to 'gemini' instead of 'auto': ANTHROPIC_API_KEY is not
-- yet configured in this environment, so 'auto' silently routes Haiku-only
-- modes (companion, notes-summarize, etc.) through the Tier-2 Gemini fallback
-- in aiGenerate() anyway -- explicit 'gemini' makes that the documented
-- default instead of an implicit fallback, per user instruction to use
-- Gemini until the Claude API is set up. Existing rows still at the
-- untouched 'auto' default are backfilled too (no user has explicitly
-- chosen 'auto' since the column was added).
alter table public.profiles
  alter column ai_provider set default 'gemini';

update public.profiles
  set ai_provider = 'gemini'
  where ai_provider = 'auto';
