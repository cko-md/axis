-- Moves vector and pg_trgm extensions out of the public schema into the
-- dedicated extensions schema, per Supabase security advisor lint
-- 0014_extension_in_public. Both extensions previously landed in public
-- because 023_pgvector.sql and 026_search_indexes.sql created them with no
-- SET SCHEMA clause. The extensions schema already exists in this project
-- and is already on the database-level default search_path
-- ("$user", public, extensions), so dependent objects (HNSW index on
-- note_embeddings.embedding, trigram GIN indexes on tasks/people/signals/
-- notes title columns, similarity()/ilike queries) continue to resolve
-- correctly without any other change.
--
-- The one exception: public.search_note_embeddings is SECURITY DEFINER with
-- an explicit pinned search_path=public (set in 027_security_definer_lockdown.sql)
-- and its body uses the unqualified <=> vector operator. After the extension
-- moves, that pinned search_path no longer includes the schema that owns the
-- operator, so we extend it to also include extensions.

alter extension vector set schema extensions;
alter extension pg_trgm set schema extensions;

alter function public.search_note_embeddings(vector, integer)
  set search_path = public, extensions;
