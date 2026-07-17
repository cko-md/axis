-- note_embeddings.note_id had no UNIQUE constraint, so the app's
-- upsert(..., { onConflict: "note_id" }) in /api/embeddings would fail at
-- the DB level with "no unique or exclusion constraint matching ON CONFLICT
-- specification" on every call — semantic search embeddings were never
-- actually persisted. Also adds an FK with cascade delete so a deleted note's
-- embedding can't outlive it and surface as a dead link in search results.

alter table public.note_embeddings
  add constraint note_embeddings_note_id_key unique (note_id);

alter table public.note_embeddings
  add constraint note_embeddings_note_id_fkey
  foreign key (note_id) references public.notes(id) on delete cascade;
