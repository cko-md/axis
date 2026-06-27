import type { SupabaseClient } from "@supabase/supabase-js";
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

const WEBHOOK_ENV_BY_KIND: Record<NotifyKind, string> = {
  daily_brief: "MAKE_WEBHOOK_DAILY_BRIEF_URL",
  weekly_recap: "MAKE_WEBHOOK_WEEKLY_RECAP_URL",
  bill_reminder: "MAKE_WEBHOOK_BILL_REMINDER_URL",
  budget_alert: "MAKE_WEBHOOK_BUDGET_ALERT_URL",
  anomaly_alert: "MAKE_WEBHOOK_ANOMALY_ALERT_URL",
  subscription_audit: "MAKE_WEBHOOK_SUBSCRIPTION_AUDIT_URL",
};

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

/**
 * Fires a Make webhook for one notification event. Always writes an
 * audit_logs row first (result: pending_confirmation on the fire attempt,
 * then success/failure) so a retry of the same cron run can be told apart
 * from a fresh event by idempotencyKey, even though Make delivery itself
 * isn't confirmed back to the app (best-effort — Make's own scenario
 * history is the source of truth for whether the email actually sent).
 *
 * No-ops (logs and returns) when the scenario's webhook URL isn't
 * configured yet — FIN-507 (the Make scenarios themselves) is manual
 * Make-UI work, not code, so this stays silent-safe until that's done.
 */
export async function notifyViaMake(admin: SupabaseClient, payload: NotifyPayload): Promise<{ sent: boolean; reason?: string }> {
  const envVar = WEBHOOK_ENV_BY_KIND[payload.kind];
  const webhookUrl = process.env[envVar];

  if (!webhookUrl) {
    await admin.from("audit_logs").insert({
      user_id: payload.userId,
      actor: "system",
      action: `notify.${payload.kind}`,
      payload: { idempotency_key: payload.idempotencyKey, reason: "webhook_not_configured" },
      result: "pending_confirmation",
    });
    return { sent: false, reason: "WEBHOOK_NOT_CONFIGURED" };
  }

  try {
    await triggerWebhook(webhookUrl, {
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
    await admin.from("audit_logs").insert({
      user_id: payload.userId,
      actor: "system",
      action: `notify.${payload.kind}`,
      payload: { idempotency_key: payload.idempotencyKey },
      result: "success",
    });
    return { sent: true };
  } catch (err) {
    await admin.from("audit_logs").insert({
      user_id: payload.userId,
      actor: "system",
      action: `notify.${payload.kind}`,
      payload: { idempotency_key: payload.idempotencyKey, error: err instanceof Error ? err.message : String(err) },
      result: "failure",
    });
    return { sent: false, reason: "DELIVERY_FAILED" };
  }
}
