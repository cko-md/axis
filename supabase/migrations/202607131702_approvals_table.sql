-- 202607131702_approvals_table.sql
-- DRAFT — DO NOT APPLY blindly. Pending human + RLS review before running
-- against any Supabase target. Backs the pure policy layer in
-- src/lib/security/actionPolicy.ts (wave 5.1 of docs/axis-redesign) — a new
-- table, additive, touches no existing data.
--
-- Persists the approval object described in the program's security model
-- (§11.3): every gate produced by decideApproval() that resolves to
-- "approval" or "approval_step_up" gets a durable, auditable row here rather
-- than a transient in-memory prompt. Financial execution and destructive
-- admin approvals must carry `step_up_verified_at`; application code (not
-- this schema) is responsible for refusing to execute without it.

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  action_class text not null
    check (action_class in (
      'READ', 'DRAFT', 'SIMULATE', 'INTERNAL_WRITE',
      'EXTERNAL_COMMUNICATION', 'FINANCIAL_EXECUTION', 'DESTRUCTIVE_ADMIN'
    )),
  requirement text not null
    check (requirement in ('approval', 'approval_step_up')),
  -- Why this approval was required (decideApproval() reasons, joined) — never
  -- just a bare "Allow" button; always show the full scope (§11.3).
  reasons text[] not null default '{}',
  -- Exact proposed action: tool name, target entity, amount/quantity,
  -- before/after state. Kept as jsonb because the shape varies by action
  -- class; validate shape in application code.
  proposed_action jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'executed')),
  -- Required before a FINANCIAL_EXECUTION / DESTRUCTIVE_ADMIN approval may be
  -- acted on. Application code must enforce this — the schema only stores it.
  step_up_verified_at timestamptz,
  decided_at timestamptz,
  expires_at timestamptz,
  -- One-time (default) vs. a persistent, routine-scoped standing permission.
  scope text not null default 'one_time' check (scope in ('one_time', 'persistent')),
  created_at timestamptz not null default now()
);

alter table public.approvals enable row level security;

drop policy if exists "approvals_select_own" on public.approvals;
create policy "approvals_select_own"
  on public.approvals for select using (auth.uid() = user_id);
drop policy if exists "approvals_insert_own" on public.approvals;
create policy "approvals_insert_own"
  on public.approvals for insert with check (auth.uid() = user_id);
drop policy if exists "approvals_update_own" on public.approvals;
create policy "approvals_update_own"
  on public.approvals for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- No delete policy: approvals are a permanent audit record. Denied/expired
-- approvals are marked via `status`, never removed.

create index if not exists idx_approvals_user_status
  on public.approvals (user_id, status, created_at desc);

-- Review checklist before applying:
--   1. Confirm target Supabase project.
--   2. `supabase db diff` against a shadow DB.
--   3. Confirm application code enforces step_up_verified_at for
--      FINANCIAL_EXECUTION / DESTRUCTIVE_ADMIN before treating status =
--      'approved' as sufficient to execute (this is a code-level gate, not a
--      DB constraint, by design — see src/lib/security/actionPolicy.ts).
--   4. Confirm no delete policy is the desired posture (approvals are an
--      audit trail) before applying.
--   5. Apply via the project's standard Supabase migration flow.
