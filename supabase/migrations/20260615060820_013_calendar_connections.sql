-- Calendar OAuth tokens (Google, Outlook) + sync IDs on schedule_events

CREATE TABLE IF NOT EXISTS calendar_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('google', 'outlook')),
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at     timestamptz,
  calendar_email text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE(user_id, provider)
);

ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own calendar connections"
  ON calendar_connections FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Add external calendar event IDs to schedule_events for sync tracking
ALTER TABLE schedule_events
  ADD COLUMN IF NOT EXISTS gcal_event_id    text,
  ADD COLUMN IF NOT EXISTS outlook_event_id text;
