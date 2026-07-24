import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MakeOutboxRow,
  MakeOutboxStore,
} from "@/lib/integrations/makeOutbox";

const mocks = vi.hoisted(() => ({
  optionalEnv: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/env", () => ({ optionalEnv: mocks.optionalEnv }));

import { notifyViaMake } from "./notifyViaMake";

const NOW = "2026-07-23T12:00:00.000Z";

function pendingRow(): MakeOutboxRow {
  return {
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
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("Make webhook acceptance boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.optionalEnv.mockImplementation((name: string) =>
      name === "PASSKEY_ENCRYPTION_KEY"
        ? "11".repeat(32)
        : "https://hook.us2.make.com/opaque-token",
    );
  });

  it("returns pending confirmation after a 2xx accepted response", async () => {
    let row = pendingRow();
    const store: MakeOutboxStore = {
      enqueue: vi.fn(async (input) => {
        row = { ...row, payload_ciphertext: input.payloadCiphertext };
        return { ok: true as const, data: row };
      }),
      getOwned: vi.fn(async () => ({ ok: true as const, data: row })),
      claim: vi.fn(async ({ claimToken, now }) => {
        row = {
          ...row,
          attempt_count: 1,
          claim_token: claimToken,
          locked_at: now,
          updated_at: now,
        };
        return { ok: true as const, data: row };
      }),
      complete: vi.fn(async ({ completion, now }) => {
        if (!completion.accepted) throw new Error("expected acceptance");
        row = {
          ...row,
          status: "accepted",
          claim_token: null,
          locked_at: null,
          accepted_at: now,
          delivered_at: null,
          last_error_code: "delivery_confirmation_pending",
          last_http_status: completion.status,
          updated_at: now,
        };
        return { ok: true as const, data: row };
      }),
      failWithoutAttempt: vi.fn(async () => ({ ok: true as const, data: row })),
    };
    const admin = {
      from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })),
    } as unknown as SupabaseClient;

    const result = await notifyViaMake(admin, {
      idempotencyKey: "daily:user-1:2026-07-23",
      kind: "daily_brief",
      userId: "user-1",
      to: "person@example.com",
      subject: "Brief",
      bodyText: "Private body",
    }, {
      store,
      now: () => new Date(NOW),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      trigger: vi.fn(async () => ({ ok: true as const, data: { accepted: true as const, status: 202 } })),
    });

    expect(result).toMatchObject({
      sent: false,
      accepted: true,
      reason: "DELIVERY_UNCONFIRMED",
      status: 202,
    });
    expect(row).toMatchObject({
      status: "accepted",
      accepted_at: NOW,
      delivered_at: null,
    });
  });
});
