-- Notes AI study aids: persisted artifacts (flashcards, quiz, mindmap, summary)
-- generated from a note's body. Owner-only RLS, mirroring the notes table.
--
-- NOTE: This migration is applied post-merge by the coordinator. Application
-- code that reads/writes note_artifacts MUST tolerate this table being absent
-- (guard inserts/selects in try/catch) so the build and runtime degrade
-- gracefully before the migration lands.

CREATE TABLE IF NOT EXISTS public.note_artifacts (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id    uuid        NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type       text        NOT NULL CHECK (type IN ('flashcards', 'quiz', 'mindmap', 'summary')),
  data       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.note_artifacts ENABLE ROW LEVEL SECURITY;

-- Owner-only policies. auth.uid() wrapped in (select ...) so Postgres can
-- initplan it once per query rather than re-evaluating per row (matches the
-- perf convention established in 031_fix_rls_auth_initplan_perf.sql).
CREATE POLICY "note_artifacts_select_own"
  ON public.note_artifacts FOR SELECT
  USING ((select auth.uid()) = user_id);

CREATE POLICY "note_artifacts_insert_own"
  ON public.note_artifacts FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "note_artifacts_update_own"
  ON public.note_artifacts FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "note_artifacts_delete_own"
  ON public.note_artifacts FOR DELETE
  USING ((select auth.uid()) = user_id);

-- Fast lookup of a note's artifacts, newest first.
CREATE INDEX IF NOT EXISTS note_artifacts_note_idx
  ON public.note_artifacts (note_id, created_at DESC);

-- FK index on user_id (matches the fk-index convention in migration 032).
CREATE INDEX IF NOT EXISTS note_artifacts_user_idx
  ON public.note_artifacts (user_id);
