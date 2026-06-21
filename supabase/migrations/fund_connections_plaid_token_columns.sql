-- Add encrypted token storage + updated_at tracking to fund_connections so
-- Plaid (and future providers) access tokens are stored the same way as
-- calendar_connections/mail_connections/contacts_connections: AES-256-GCM
-- encrypted via src/lib/crypto.ts, never in plaintext.
ALTER TABLE public.fund_connections
  ADD COLUMN IF NOT EXISTS access_token_enc text,
  ADD COLUMN IF NOT EXISTS refresh_token_enc text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
