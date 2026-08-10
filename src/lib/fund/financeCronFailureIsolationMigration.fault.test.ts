import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260809270000_finance_cron_failure_isolation.sql"),
  "utf8",
).toLowerCase();

describe("finance cron poison-item isolation migration", () => {
  it("persists bounded retry and quarantine state behind service-only RPCs", () => {
    expect(sql).toContain("finance_cron_item_failures");
    expect(sql).toContain("attempt_count between 1 and 3");
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).toContain("interval '2 hours'");
    expect(sql).toContain("return case when v_attempts >= 3 then 'quarantined' else 'retry_scheduled' end");
    expect(sql).toContain("revoke all on table public.finance_cron_item_failures");
    expect(sql).toContain("revoke all on table public.finance_cron_cursors");
  });

  it("requires a live token-bound unfinished claim before failure can advance", () => {
    expect(sql).toContain("create or replace function public.fail_finance_cron_item");
    expect(sql).toContain("where lease.job_key = 'finance-daily' for update");
    expect(sql).toContain("v_owner is distinct from p_run_id");
    expect(sql).toContain("v_expiry <= pg_catalog.clock_timestamp()");
    expect(sql).toContain("claim.completed_at is null");
    expect(sql).toContain("grant execute on function public.fail_finance_cron_item(uuid,text,uuid,text)");
  });

  it("excludes backed-off and quarantined rows while allowing later fresh work", () => {
    expect(sql).toContain("failure.quarantined_at is null");
    expect(sql).toContain("failure.next_attempt_at <= pg_catalog.now()");
    expect(sql).toContain("not exists (\n        select 1 from public.finance_cron_item_failures failure");
    expect(sql).toContain("delete from public.finance_cron_item_failures failure");
  });
});
