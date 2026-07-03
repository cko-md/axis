-- PROD-1 reconciliation: recover the untracked `profiles.bio` change that was
-- applied to production (remote migration version 20260625224935 "profiles_bio")
-- but had no local migration file. Idempotent — the column already exists in
-- prod, so this only matters when rebuilding the schema from scratch. Timestamp
-- prefix matches the remote applied version so ordering is preserved.
alter table public.profiles add column if not exists bio text;
