-- Check Retrieved Timestamp Column
-- Supabase SQL snippet 762e71e0-e299-4b8d-a209-853c9edb5a6b
-- created 2026-07-15T21:33:36.463799+00:00
-- restored from the Supabase dashboard via: supabase snippets download 762e71e0-e299-4b8d-a209-853c9edb5a6b
select column_name from information_schema.columns
where table_name = 'fund_bank_transactions' and column_name = 'retrieved_at';
