-- Make webhook retries must be atomic: the lookup in the route is only a fast
-- path, while this unique expression index closes the concurrent-insert race.
create unique index if not exists idx_audit_logs_make_webhook_idempotency
  on public.audit_logs (user_id, action, (payload->>'idempotency_key'))
  where action like 'make:%' and payload ? 'idempotency_key';
