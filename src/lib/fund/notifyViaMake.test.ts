import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionalEnv } from "@/lib/env";
import { triggerWebhook } from "@/lib/integrations/make";
import { notifyViaMake, type NotifyPayload } from "./notifyViaMake";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn() }));
vi.mock("@/lib/integrations/make", () => ({ triggerWebhook: vi.fn() }));

const optionalEnvMock = vi.mocked(optionalEnv);
const triggerWebhookMock = vi.mocked(triggerWebhook);

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
  return { admin, rows, insert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notifyViaMake", () => {
  it("records an honest non-delivery when the scenario is not configured", async () => {
    optionalEnvMock.mockReturnValue(undefined);
    const { admin, rows } = adminWithAudit();

    const result = await notifyViaMake(admin, payload);

    expect(result).toEqual({
      sent: false,
      reason: "WEBHOOK_NOT_CONFIGURED",
      retryable: false,
      auditRecorded: true,
    });
    expect(triggerWebhookMock).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "pending_confirmation" });
  });

  it("fails closed when the preflight audit cannot be written", async () => {
    optionalEnvMock.mockReturnValue("https://hook.us2.make.com/opaque-token");
    const { admin } = adminWithAudit([new Error("db unavailable")]);

    const result = await notifyViaMake(admin, payload);

    expect(result).toEqual({
      sent: false,
      reason: "AUDIT_WRITE_FAILED",
      retryable: true,
      auditRecorded: false,
    });
    expect(triggerWebhookMock).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("stores only safe failure metadata after a rejected delivery", async () => {
    optionalEnvMock.mockReturnValue("https://hook.us2.make.com/opaque-token");
    triggerWebhookMock.mockResolvedValue({
      ok: false,
      error: {
        code: "provider_error",
        message: "raw provider content must not persist",
        retryable: true,
        provider: "make",
        status: 503,
      },
    });
    const { admin, rows } = adminWithAudit();

    const result = await notifyViaMake(admin, payload);

    expect(result).toEqual({
      sent: false,
      reason: "DELIVERY_FAILED",
      retryable: true,
      auditRecorded: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      result: "failure",
      payload: {
        idempotency_key: payload.idempotencyKey,
        error_code: "provider_error",
        status: 503,
        retryable: true,
      },
    });
    expect(JSON.stringify(rows)).not.toContain("raw provider content");
    expect(JSON.stringify(rows)).not.toContain(payload.to);
    expect(JSON.stringify(rows)).not.toContain(payload.bodyText);
  });

  it("returns delivery and audit state independently", async () => {
    optionalEnvMock.mockReturnValue("https://hook.us2.make.com/opaque-token");
    triggerWebhookMock.mockResolvedValue({ ok: true, data: { accepted: true, status: 202 } });
    const { admin, rows } = adminWithAudit([null, new Error("audit unavailable")]);

    const result = await notifyViaMake(admin, payload);

    expect(result).toEqual({ sent: true, status: 202, auditRecorded: false });
    expect(rows.map((row) => row.result)).toEqual(["pending_confirmation", "success"]);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
