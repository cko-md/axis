import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/20260723223000_user_security_state.sql"),
  "utf8",
).toLowerCase();

describe("user security-state migration invariants", () => {
  it("enables owner-only RLS and exposes no authenticated write grant", () => {
    expect(migration).toContain(
      "alter table public.user_security_state enable row level security",
    );
    expect(migration).toMatch(
      /create policy "user_security_state_select_own"[\s\S]*for select[\s\S]*to authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id/,
    );
    expect(migration).toContain(
      "revoke all on table public.user_security_state from anon, authenticated",
    );
    expect(migration).toContain(
      "grant select on table public.user_security_state to authenticated",
    );
    expect(migration).not.toMatch(
      /grant\s+(insert|update|delete|all)[\s\S]*user_security_state[\s\S]*to authenticated/,
    );
  });

  it("keeps security-definer functions on an empty search path and binds rotation to auth.uid()", () => {
    expect(migration).toMatch(
      /function public\.axis_create_user_security_state\(\)[\s\S]*security definer[\s\S]*set search_path = ''/,
    );
    expect(migration).toMatch(
      /function public\.rotate_own_mfa_trust_epoch\(\)[\s\S]*security definer[\s\S]*set search_path = ''/,
    );
    expect(migration).toMatch(
      /update public\.user_security_state[\s\S]*where user_id = auth\.uid\(\)/,
    );
    expect(migration).toContain(
      "revoke all on function public.rotate_own_mfa_trust_epoch() from public, anon",
    );
    expect(migration).toContain(
      "grant execute on function public.rotate_own_mfa_trust_epoch() to authenticated",
    );
  });

  it("installs the auth.users trigger before backfill closes the concurrent-signup gap", () => {
    const triggerIndex = migration.indexOf(
      "create trigger axis_create_user_security_state",
    );
    const backfillIndex = migration.indexOf(
      "insert into public.user_security_state (user_id)\nselect id from auth.users",
    );

    expect(triggerIndex).toBeGreaterThanOrEqual(0);
    expect(backfillIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeLessThan(backfillIndex);
  });
});
