CREATE TABLE IF NOT EXISTS health_check_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  all_ok      BOOLEAN NOT NULL DEFAULT true,
  overdue_tasks       JSONB,
  old_signals_deleted JSONB,
  dependency_check    JSONB,
  supabase_health     JSONB,
  extra               JSONB
);

-- Only service role can write; admins can read
ALTER TABLE health_check_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "health_runs_service_only" ON health_check_runs
  FOR ALL USING (false);
