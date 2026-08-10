import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSupabaseMakeOutboxStore,
  isMakeOutboxReplayable,
  type MakeOutboxRow,
  type MakeOutboxMetadataRow,
} from "./makeOutbox";

describe("Make acceptance is not delivery", () => {
  it("does not make an accepted row replayable or delivered", () => {
    const row: MakeOutboxMetadataRow = {
      id: "delivery-1",
      provider: "make",
      event_type: "daily_brief",
      status: "accepted",
      attempt_count: 1,
      last_error_code: "delivery_confirmation_pending",
      last_http_status: 202,
      locked_at: null,
      accepted_at: "2026-07-23T12:00:00.000Z",
      delivered_at: null,
      created_at: "2026-07-23T12:00:00.000Z",
      updated_at: "2026-07-23T12:00:00.000Z",
    };

    expect(isMakeOutboxReplayable(row)).toBe(false);
    expect(row.status).not.toBe("delivered");
    expect(row.delivered_at).toBeNull();
  });

  it("binds an outbox enqueue mutation to the caller cancellation signal", async () => {
    const controller = new AbortController();
    const stored = {
      id: "delivery-1",
      user_id: "user-1",
      provider: "make",
      event_type: "daily_brief",
      dedupe_key_hash: "a".repeat(64),
      payload_ciphertext: "ciphertext",
      status: "pending",
      attempt_count: 0,
      last_error_code: null,
      last_http_status: null,
      claim_token: null,
      locked_at: null,
      accepted_at: null,
      delivered_at: null,
      created_at: "2026-07-23T12:00:00.000Z",
      updated_at: "2026-07-23T12:00:00.000Z",
    } satisfies MakeOutboxRow;
    const abortSignal = vi.fn(async () => ({ data: stored, error: null }));
    const query = { abortSignal };
    const admin = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(() => query),
          })),
        })),
      })),
    } as unknown as SupabaseClient;

    const result = await createSupabaseMakeOutboxStore(admin).enqueue({
      userId: "user-1",
      eventType: "daily_brief",
      dedupeKeyHash: "a".repeat(64),
      payloadCiphertext: "ciphertext",
      now: "2026-07-23T12:00:00.000Z",
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: true });
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });
});
