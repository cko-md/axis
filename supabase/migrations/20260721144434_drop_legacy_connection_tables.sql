-- Drop the legacy direct-OAuth connection tables. Mail/Calendar/Contacts are
-- Composio-only after the direct-adapter removal (commit 6fedaceb): no code
-- reads or writes these tables, they held zero rows in production, and nothing
-- (foreign keys, views, functions) depends on them — only their own RLS
-- policies, which drop with the table. Idempotent; no CASCADE needed.
drop table if exists public.mail_connections;
drop table if exists public.calendar_connections;
drop table if exists public.contacts_connections;
