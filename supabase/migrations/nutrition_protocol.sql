-- Per-user singleton row holding diet protocol, macro targets, hydration, and notes
-- for the Vitality > Nutrition "Targets & Notes" card. Mirrors the persistence
-- pattern used by user_preferences / training_sessions.
CREATE TABLE IF NOT EXISTS public.nutrition_protocol (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  diet_protocol text NOT NULL DEFAULT 'high-protein',
  protein_target_g_per_lb numeric NOT NULL DEFAULT 1.0,
  hydration_target_l numeric NOT NULL DEFAULT 3.0,
  hydration_current_l numeric NOT NULL DEFAULT 0,
  training_day_carb_bump_g integer NOT NULL DEFAULT 40,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.nutrition_protocol ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "nutrition_protocol_select_own" ON public.nutrition_protocol;
CREATE POLICY "nutrition_protocol_select_own" ON public.nutrition_protocol
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "nutrition_protocol_insert_own" ON public.nutrition_protocol;
CREATE POLICY "nutrition_protocol_insert_own" ON public.nutrition_protocol
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "nutrition_protocol_update_own" ON public.nutrition_protocol;
CREATE POLICY "nutrition_protocol_update_own" ON public.nutrition_protocol
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "nutrition_protocol_delete_own" ON public.nutrition_protocol;
CREATE POLICY "nutrition_protocol_delete_own" ON public.nutrition_protocol
  FOR DELETE USING (auth.uid() = user_id);
