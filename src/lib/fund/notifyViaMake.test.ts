import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionalEnv } from "@/lib/env";
import {
  makeOutboxDedupeHash,
  sealMakeOutboxPayload,
  type MakeOutboxRow,
  type MakeOutboxStore,
  type MakeOutboxStoreResult,
} from "@/lib/integrations/makeOutbox";
import {
  notifyViaMake,
  replayMakeNotification,
  type NotifyPayload,
} from "./notifyViaMake";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn() }));

const optionalEnvMock = vi.mocked(optionalEnv);
let webhookUrl: string | undefined;

const payload: NotifyPayload = {
  idempotencyKey: "daily_brief:user-1:2026-07-15",
  kind: "daily_brief",
  userId: "user-1",
  to: "private@example.com",
  subject: "Private subject",
  bodyText: "Private finance body",
};

function adminWithAudit(errors: Array<Error | null> = []) {
  const rows: Array<Record<string, unknown>> = [];
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    rows.push(row);
    return { error: errors[rows.length - 1] ?? null };
  });
  const admin = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
  return { admin, rows };
}

function makeRow(ciphertext: string): MakeOutboxRow {
  return {
    id: "delivery-1",
    user_id: payload.userId,
    provider: "make",
    event_type: payload.kind,
    dedupe_key_hash: makeOutboxDedupeHash(payload.userId, payload.idempotencyKey),
    payload_ciphertext: ciphertext,
    status: "pending",
    attempt_count: 0,
    last_error_code: null,
    last_http_status: null,
    claim_token: null,
    locked_at: null,
    delivered_at: null,
    created_at: "2026-07-15T12:00:00.000Z",
    updated_at: "2026-07-15T12:00:00.000Z",
  };
}

function fakeStore(initial?: MakeOutboxRow) {
  let current = initial;
  let duplicate: MakeOutboxRow | undefined;
  const store: MakeOutboxStore = {
    enqueue: vi.fn(async (input): Promise<MakeOutboxStoreResult<MakeOutboxRow>> => {
      if (duplicate) return { ok: false, code: "duplicate", existing: duplicate };
      const next = makeRow(input.payloadCiphertext);
      current = next;
      return { ok: true, data: next };
    }),
    getOwned: vi.fn(
      async (): Promise<MakeOutboxStoreResult<MakeOutboxRow | null>> => ({
        ok: true,
        data: current ?? null,
      }),
    ),
    claim: vi.fn(async ({ row, claimToken, now }): Promise<MakeOutboxStoreResult<MakeOutboxRow>> => {
      const next: MakeOutboxRow = {
        ...row,
        status: "pending",
        attempt_count: row.attempt_count + 1,
        claim_token: claimToken,
        locked_at: now,
        last_error_code: null,
        last_http_status: null,
        updated_at: now,
      };
      current = next;
      return { ok: true, data: next };
    }),
    complete: vi.fn(async ({ row, completion, now }): Promise<MakeOutboxStoreResult<MakeOutboxRow>> => {
      const next: MakeOutboxRow = completion.accepted
        ? {
            ...row,
            status: "delivered",
            last_error_code: null,
            last_http_status: completion.status,
            claim_token: null,
            locked_at: null,
            delivered_at: now,
            updated_at: now,
          }
        : {
            ...row,
            status: row.attempt_count >= 3 ? "dead_letter" : "failed",
            last_error_code: completion.errorCode,
            last_http_status: completion.status ?? null,
            claim_token: null,
            locked_at: null,
            delivered_at: null,
            updated_at: now,
          };
      current = next;
      return { ok: true, data: next };
    }),
    failWithoutAttempt: vi.fn(async ({ row, errorCode, now }): Promise<MakeOutboxStoreResult<MakeOutboxRow>> => {
      const next: MakeOutboxRow = {
        ...row,
        status: "failed",
        last_error_code: errorCode,
        claim_token: null,
        locked_at: null,
        updated_at: now,
      };
      current = next;
      return { ok: true, data: next };
    }),
  };
  return {
    store,
    row: () => current,
    setDuplicate: (row: MakeOutboxRow) => {
      duplicate = row;
    },
  };
}

const now = () => new Date("2026-07-15T12:10:00.000Z");
const randomUUID = () => "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  webhookUrl = "https://hook.us2.make.com/opaque-token";
  optionalEnvMock.mockImplementation((name) =>
    name === "PASSKEY_ENCRYPTION_KEY" ? "11".repeat(32) : webhookUrl,
  );
});

describe("notifyViaMake durable outbox", () => {
  it("queues an encrypted, replayable non-delivery when the scenario is not configured", async () => {
    webhookUrl = undefined;
    const { admin, rows } = adminWithAudit();
    const fake = fakeStore();

    const result = await notifyViaMake(admin, payload, {
      store: fake.store,
      now,
      randomUUID,
      trigger: vi.fn(),
    });

    expect(result).toMatchObject({
      sent: false,
      reason: "WEBHOOK_NOT_CONFIGURED",
      deliveryId: "delivery-1",
      outboxRecorded: true,
    });
    expect(fake.row()).toMatchObject({ status: "failed", last_error_code: "webhook_not_configured" });
    expect(fake.row()?.payload_ciphertext).not.toContain(payload.to);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(payload.idempotencyKey);
    expect(JSON.stringify(rows)).not.toContain(payload.bodyText);
  });

  it("fails closed and leaves a replayable row when the preflight audit fails", async () => {
    const { admin } = adminWithAudit([new Error("db unavailable")]);
    const fake = fakeStore();
    const trigger = vi.fn();

    const result = await notifyViaMake(admin, payload, {
      store: fake.store,
      now,
      randomUUID,
      trigger,
    });

    expect(result).toMatchObject({ sent: false, reason: "AUDIT_WRITE_FAILED" });
    expect(trigger).not.toHaveBeenCalled();
    expect(fake.row()).toMatchObject({ status: "failed", last_error_code: "audit_write_failed" });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("records a provider failure without persisting its message or private payload", async () => {
    const { admin, rows } = adminWithAudit();
    const fake = fakeStore();
    const trigger = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "provider_error",
        message: "raw provider content must not persist",
        retryable: true,
        provider: "make",
        status: 503,
      },
    });

    const result = await notifyViaMake(admin, payload, {
      store: fake.store,
      now,
      randomUUID,
      trigger,
    });

    expect(result).toMatchObject({ sent: false, reason: "DELIVERY_FAILED", outboxRecorded: true });
    expect(fake.row()).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error_code: "provider_error",
      last_http_status: 503,
    });
    expect(JSON.stringify(rows)).not.toContain("raw provider content");
    expect(JSON.stringify(rows)).not.toContain(payload.to);
    expect(JSON.stringify(rows)).not.toContain(payload.bodyText);
  });

  it("keeps accepted delivery distinct from a failed outcome-audit write", async () => {
    const { admin } = adminWithAudit([null, new Error("audit unavailable")]);
    const fake = fakeStore();
    const trigger = vi.fn().mockResolvedValue({ ok: true, data: { accepted: true, status: 202 } });

    const result = await notifyViaMake(admin, payload, {
      store: fake.store,
      now,
      randomUUID,
      trigger,
    });

    expect(result).toMatchObject({
      sent: true,
      status: 202,
      auditRecorded: false,
      outboxRecorded: true,
    });
    expect(fake.row()).toMatchObject({ status: "delivered", last_http_status: 202 });
  });

  it("deduplicates a previously delivered event without another provider call", async () => {
    const { admin } = adminWithAudit();
    const fake = fakeStore();
    const hash = makeOutboxDedupeHash(payload.userId, payload.idempotencyKey);
    const sealed = sealMakeOutboxPayload(payload, hash);
    if (!sealed.ok) throw new Error("test setup failed");
    fake.setDuplicate({
      ...makeRow(sealed.data),
      status: "delivered",
      last_http_status: 202,
      delivered_at: now().toISOString(),
    });
    const trigger = vi.fn();

    const result = await notifyViaMake(admin, payload, { store: fake.store, now, trigger });

    expect(result).toMatchObject({ sent: true, deduped: true, status: 202 });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("replays a failed encrypted row only after an explicit call", async () => {
    const hash = makeOutboxDedupeHash(payload.userId, payload.idempotencyKey);
    const sealed = sealMakeOutboxPayload(payload, hash);
    if (!sealed.ok) throw new Error("test setup failed");
    const failed = {
      ...makeRow(sealed.data),
      status: "failed" as const,
      attempt_count: 1,
      last_error_code: "network",
    };
    const fake = fakeStore(failed);
    const { admin } = adminWithAudit();
    const trigger = vi.fn().mockResolvedValue({ ok: true, data: { accepted: true, status: 200 } });

    const result = await replayMakeNotification(admin, failed, {
      store: fake.store,
      now,
      randomUUID,
      trigger,
    });

    expect(result).toMatchObject({ sent: true, status: 200, deduped: false });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(fake.row()).toMatchObject({ status: "delivered", attempt_count: 2 });
  });
});
