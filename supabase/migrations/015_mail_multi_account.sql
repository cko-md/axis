-- Allow multiple email accounts per provider
-- Replace single-provider constraint with user_id+provider+mail_email
ALTER TABLE mail_connections DROP CONSTRAINT IF EXISTS mail_connections_user_id_provider_key;
DELETE FROM mail_connections WHERE mail_email IS NULL;
ALTER TABLE mail_connections ALTER COLUMN mail_email SET NOT NULL;
ALTER TABLE mail_connections ADD CONSTRAINT mail_connections_user_id_provider_email_key
  UNIQUE (user_id, provider, mail_email);
