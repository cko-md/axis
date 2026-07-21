-- Add Retrieved Timestamp Column
-- Supabase SQL snippet 15788b96-6a53-4ec4-a055-40a08b98b1b2
-- created 2026-07-15T21:33:03.800546+00:00
-- restored from the Supabase dashboard via: supabase snippets download 15788b96-6a53-4ec4-a055-40a08b98b1b2
alter table public.fund_bank_transactions
  add column if not exists retrieved_at timestamptz;
