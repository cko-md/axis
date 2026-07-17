-- Mail OAuth token storage (Gmail + Outlook, read-only)
CREATE TABLE IF NOT EXISTS mail_connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at   TIMESTAMPTZ,
  mail_email   TEXT,
  updated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE mail_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mail_connections_own" ON mail_connections
  FOR ALL USING (auth.uid() = user_id);
