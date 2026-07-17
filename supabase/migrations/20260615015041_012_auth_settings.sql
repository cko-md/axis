-- ── WebAuthn / Passkey credentials ────────────────────────────────────────────
create table if not exists public.user_passkeys (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  credential_id         text not null unique,
  credential_public_key text not null,   -- base64url encoded CBOR public key
  counter               bigint not null default 0,
  device_type           text check (device_type in ('platform', 'cross-platform')),
  backed_up             boolean default false,
  transports            text[],
  name                  text not null default 'My device',
  -- Encrypted Supabase refresh token — used to restore session after passkey auth
  -- without service-role key. Updated by the client on every auth state change.
  refresh_token_enc     text,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz
);

alter table public.user_passkeys enable row level security;

create policy "Users manage own passkeys"
  on public.user_passkeys for all
  using (auth.uid() = user_id);

-- ── Short-lived WebAuthn challenge storage ─────────────────────────────────────
-- Server generates a random challenge, stores it here, client signs it,
-- server verifies and deletes it. Expires after 5 minutes.
create table if not exists public.webauthn_challenges (
  id         uuid primary key default gen_random_uuid(),
  challenge  text not null unique,
  type       text not null check (type in ('registration', 'authentication')),
  user_id    uuid references auth.users(id) on delete cascade,  -- null for login challenges
  email      text,           -- carried so server knows who to restore on auth
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now()
);
-- No RLS — server-only table managed via API routes.
-- Clean up expired rows automatically.
create index if not exists webauthn_challenges_expires_at_idx
  on public.webauthn_challenges (expires_at);

-- ── Per-user auth preferences ──────────────────────────────────────────────────
create table if not exists public.user_auth_settings (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  passkey_enabled    boolean not null default false,
  biometric_prompted boolean not null default false, -- has user been shown the "use biometrics?" one-time prompt
  twofa_enabled      boolean not null default false,
  twofa_method       text check (twofa_method in ('totp', 'sms', 'email')),
  recovery_email     text,   -- secondary email for password recovery
  remember_me        boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.user_auth_settings enable row level security;

create policy "Users manage own auth settings"
  on public.user_auth_settings for all
  using (auth.uid() = user_id);

-- ── Cleanup function for expired challenges ────────────────────────────────────
create or replace function public.cleanup_expired_challenges()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  delete from public.webauthn_challenges where expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.cleanup_expired_challenges() to authenticated;
