-- The daily maintenance route calls this SECURITY DEFINER function through a
-- service-role client. Browser-facing roles must not be able to expire every
-- user's approvals through the Data API.
revoke execute on function public.expire_stale_approvals() from public, anon, authenticated;
grant execute on function public.expire_stale_approvals() to service_role;
