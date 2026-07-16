import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { optionalEnv, type OptionalEnvName } from "@/lib/env";
import { triggerWebhook } from "@/lib/integrations/make";

/**
 * FIN-505: dispatch a notification event to Make for delivery. The app
 * owns scheduling/detection (cron, threshold checks) and resolves the
 * destination channel; Make owns templating + actually sending. Each kind
 * maps to its own scenario webhook URL (minted in the Make UI per FIN-507,
 * not the management API) — env var per kind, since each is a distinct
 * opaque instant-trigger URL.
 */
export type NotifyKind = "daily_brief" | "weekly_recap" | "bill_reminder" | "budget_alert" | "anomaly_alert" | "subscription_audit";

const WEBHOOK_ENV_BY_KIND = {
  daily_brief: "MAKE_WEBHOOK_DAILY_BRIEF_URL",
  weekly_recap: "MAKE_WEBHOOK_WEEKLY_RECAP_URL",
  bill_reminder: "MAKE_WEBHOOK_BILL_REMINDER_URL",
  budget_alert: "MAKE_WEBHOOK_BUDGET_ALERT_URL",
  anomaly_alert: "MAKE_WEBHOOK_ANOMALY_ALERT_URL",
  subscription_audit: "MAKE_WEBHOOK_SUBSCRIPTION_AUDIT_URL",
} satisfies Record<NotifyKind, OptionalEnvName>;

export type NotifyPayload = {
  idempotencyKey: string;
  kind: NotifyKind;
  userId: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  meta?: Record<string, unknown>;
};

export type NotifyResult =
  | { sent: true; status: number; auditRecorded: boolean }
  | {
      sent: false;
      reason: "WEBHOOK_NOT_CONFIGURED" | "AUDIT_WRITE_FAILED" | "DELIVERY_FAILED";
      retryable: boolean;
      auditRecorded: boolean;
    };

async function appendDeliveryAudit(
  admin: SupabaseClient,
  payload: NotifyPayload,
  result: "success" | "failure" | "pending_confirmation",
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const { error } = await admin.from("audit_logs").insert({
    user_id: payload.userId,
    actor: "system",
    action: `notify.${payload.kind}`,
    payload: { idempotency_key: payload.idempotencyKey, ...metadata },
    result,
  });
  if (!error) return true;

  Sentry.captureException(new Error("Make notification audit write failed"), {
    tags: {
      area: "integrations",
      provider: "make",
      operation: "notification_audit",
      notification_kind: payload.kind,
    },
  });
  return false;
}

/**
 * Fires a Make webhook for one notification event. Writes an immutable
 * pending audit row before delivery, then an immutable outcome row. If the
 * preflight audit cannot be persisted, delivery fails closed.
 *
 * Reports a non-delivery when the scenario's webhook URL isn't configured yet.
 * FIN-507 (the Make scenarios themselves) is manual Make-UI work, not code.
 */
export async function notifyViaMake(admin: SupabaseClient, payload: NotifyPayload): Promise<NotifyResult> {
  const envVar = WEBHOOK_ENV_BY_KIND[payload.kind];
  const webhookUrl = optionalEnv(envVar);

  if (!webhookUrl) {
    const auditRecorded = await appendDeliveryAudit(admin, payload, "pending_confirmation", {
      reason: "webhook_not_configured",
    });
    return {
      sent: false,
      reason: "WEBHOOK_NOT_CONFIGURED",
      retryable: false,
      auditRecorded,
    };
  }

  const preflightRecorded = await appendDeliveryAudit(admin, payload, "pending_confirmation");
  if (!preflightRecorded) {
    return {
      sent: false,
      reason: "AUDIT_WRITE_FAILED",
      retryable: true,
      auditRecorded: false,
    };
  }

  const delivery = await triggerWebhook(webhookUrl, {
    idempotency_key: payload.idempotencyKey,
    kind: payload.kind,
    user_id: payload.userId,
    channel: "email",
    to: payload.to,
    subject: payload.subject,
    body_text: payload.bodyText,
    body_html: payload.bodyHtml,
    meta: payload.meta ?? {},
  });
  if (!delivery.ok) {
    const auditRecorded = await appendDeliveryAudit(admin, payload, "failure", {
      error_code: delivery.error.code,
      status: delivery.error.status ?? null,
      retryable: delivery.error.retryable,
    });
    return {
      sent: false,
      reason: "DELIVERY_FAILED",
      retryable: delivery.error.retryable,
      auditRecorded,
    };
  }

  const auditRecorded = await appendDeliveryAudit(admin, payload, "success", {
    status: delivery.data.status,
  });
  return { sent: true, status: delivery.data.status, auditRecorded };
}
