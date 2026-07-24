import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { optionalEnv, type OptionalEnvName } from "@/lib/env";
import { triggerWebhook } from "@/lib/integrations/make";
import {
  createSupabaseMakeOutboxStore,
  isMakeOutboxReplayable,
  makeOutboxDedupeHash,
  openMakeOutboxPayload,
  sealMakeOutboxPayload,
  type MakeNotificationKind,
  type MakeNotificationPayload,
  type MakeOutboxRow,
  type MakeOutboxStore,
} from "@/lib/integrations/makeOutbox";

/**
 * FIN-505: dispatch a notification event to Make for delivery. Axis owns the
 * encrypted outbox, deterministic event generation, recipient, and audit;
 * Make owns its configured scenario and final email delivery.
 */
export type NotifyKind = MakeNotificationKind;
export type NotifyPayload = MakeNotificationPayload;

const WEBHOOK_ENV_BY_KIND = {
  daily_brief: "MAKE_WEBHOOK_DAILY_BRIEF_URL",
  weekly_recap: "MAKE_WEBHOOK_WEEKLY_RECAP_URL",
  bill_reminder: "MAKE_WEBHOOK_BILL_REMINDER_URL",
  budget_alert: "MAKE_WEBHOOK_BUDGET_ALERT_URL",
  anomaly_alert: "MAKE_WEBHOOK_ANOMALY_ALERT_URL",
  subscription_audit: "MAKE_WEBHOOK_SUBSCRIPTION_AUDIT_URL",
} satisfies Record<NotifyKind, OptionalEnvName>;

export type NotifyFailureReason =
  | "WEBHOOK_NOT_CONFIGURED"
  | "OUTBOX_ENCRYPTION_UNAVAILABLE"
  | "OUTBOX_WRITE_FAILED"
  | "OUTBOX_CLAIM_FAILED"
  | "ALREADY_QUEUED"
  | "NOT_REPLAYABLE"
  | "AUDIT_WRITE_FAILED"
  | "DELIVERY_FAILED"
  | "DELIVERY_UNCONFIRMED";

export type NotifyResult =
  | {
      sent: true;
      accepted: true;
      status: number;
      deliveryId: string;
      deduped: boolean;
      auditRecorded: boolean;
      outboxRecorded: boolean;
    }
  | {
      sent: false;
      accepted?: false;
      reason: NotifyFailureReason;
      retryable: boolean;
      deliveryId?: string;
      auditRecorded: boolean;
      outboxRecorded: boolean;
    }
  | {
      sent: false;
      accepted: true;
      reason: "DELIVERY_UNCONFIRMED";
      retryable: false;
      status: number;
      deliveryId: string;
      deduped: boolean;
      auditRecorded: boolean;
      outboxRecorded: boolean;
    };

type MakeDeliveryDependencies = {
  store?: MakeOutboxStore;
  now?: () => Date;
  randomUUID?: () => string;
  trigger?: typeof triggerWebhook;
};

function webhookUrlForKind(kind: NotifyKind): string | undefined {
  return optionalEnv(WEBHOOK_ENV_BY_KIND[kind]);
}

function captureOutboxFailure(operation: string, kind: NotifyKind) {
  Sentry.captureException(new Error(`Make outbox ${operation} failed`), {
    tags: {
      area: "integrations",
      provider: "make",
      operation,
      notification_kind: kind,
    },
  });
}

async function appendDeliveryAudit(
  admin: SupabaseClient,
  payload: NotifyPayload,
  dedupeKeyHash: string,
  result: "success" | "failure" | "pending_confirmation",
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const { error } = await admin.from("audit_logs").insert({
    user_id: payload.userId,
    actor: "system",
    action: `notify.${payload.kind}`,
    payload: { dedupe_key_hash: dedupeKeyHash, ...metadata },
    result,
  });
  if (!error) return true;
  captureOutboxFailure("notification_audit", payload.kind);
  return false;
}

function dependencies(admin: SupabaseClient, deps: MakeDeliveryDependencies) {
  return {
    store: deps.store ?? createSupabaseMakeOutboxStore(admin),
    now: deps.now ?? (() => new Date()),
    randomUUID: deps.randomUUID ?? (() => crypto.randomUUID()),
    trigger: deps.trigger ?? triggerWebhook,
  };
}

async function markUnattemptedFailure(input: {
  store: MakeOutboxStore;
  row: MakeOutboxRow;
  errorCode: string;
  now: string;
  kind: NotifyKind;
}) {
  const result = await input.store.failWithoutAttempt({
    row: input.row,
    errorCode: input.errorCode,
    now: input.now,
  });
  if (!result.ok) captureOutboxFailure("outbox_finalize", input.kind);
  return result.ok;
}

async function deliverClaimedMakeNotification(input: {
  admin: SupabaseClient;
  payload: NotifyPayload;
  row: MakeOutboxRow;
  webhookUrl: string;
  dedupeKeyHash: string;
  deps: ReturnType<typeof dependencies>;
}): Promise<NotifyResult> {
  const claimToken = input.deps.randomUUID();
  const claimedAt = input.deps.now().toISOString();
  const claim = await input.deps.store.claim({
    row: input.row,
    claimToken,
    now: claimedAt,
  });
  if (!claim.ok) {
    if (claim.code === "database") captureOutboxFailure("outbox_claim", input.payload.kind);
    return {
      sent: false,
      reason: "OUTBOX_CLAIM_FAILED",
      retryable: claim.code === "database",
      deliveryId: input.row.id,
      auditRecorded: true,
      outboxRecorded: claim.code !== "database",
    };
  }

  const delivery = await input.deps.trigger(input.webhookUrl, {
    idempotency_key: input.payload.idempotencyKey,
    kind: input.payload.kind,
    user_id: input.payload.userId,
    channel: "email",
    to: input.payload.to,
    subject: input.payload.subject,
    body_text: input.payload.bodyText,
    body_html: input.payload.bodyHtml,
    meta: input.payload.meta ?? {},
  });

  const completedAt = input.deps.now().toISOString();
  const completion = await input.deps.store.complete({
    row: claim.data,
    claimToken,
    completion: delivery.ok
      ? { accepted: true, status: delivery.data.status }
      : {
          accepted: false,
          errorCode: delivery.error.code,
          ...(delivery.error.status !== undefined ? { status: delivery.error.status } : {}),
        },
    now: completedAt,
  });
  if (!completion.ok) captureOutboxFailure("outbox_finalize", input.payload.kind);

  if (!delivery.ok) {
    const auditRecorded = await appendDeliveryAudit(
      input.admin,
      input.payload,
      input.dedupeKeyHash,
      "failure",
      {
        delivery_id: input.row.id,
        error_code: delivery.error.code,
        status: delivery.error.status ?? null,
        retryable: delivery.error.retryable,
      },
    );
    return {
      sent: false,
      reason: "DELIVERY_FAILED",
      retryable: delivery.error.retryable,
      deliveryId: input.row.id,
      auditRecorded,
      outboxRecorded: completion.ok,
    };
  }

  const confirmedDelivered = completion.ok
    && completion.data.status === "delivered"
    && typeof completion.data.delivered_at === "string";
  const auditRecorded = await appendDeliveryAudit(
    input.admin,
    input.payload,
    input.dedupeKeyHash,
    confirmedDelivered ? "success" : "pending_confirmation",
    { delivery_id: input.row.id, status: delivery.data.status },
  );
  if (confirmedDelivered) {
    return {
      sent: true,
      accepted: true,
      status: delivery.data.status,
      deliveryId: input.row.id,
      deduped: false,
      auditRecorded,
      outboxRecorded: true,
    };
  }
  return {
    sent: false,
    accepted: true,
    reason: "DELIVERY_UNCONFIRMED",
    retryable: false,
    status: delivery.data.status,
    deliveryId: input.row.id,
    deduped: false,
    auditRecorded,
    outboxRecorded: completion.ok,
  };
}

/** Queue, deduplicate, audit, claim, and attempt one Make notification. */
export async function notifyViaMake(
  admin: SupabaseClient,
  payload: NotifyPayload,
  injected: MakeDeliveryDependencies = {},
): Promise<NotifyResult> {
  const deps = dependencies(admin, injected);
  const dedupeKeyHash = makeOutboxDedupeHash(payload.userId, payload.idempotencyKey);
  const sealed = sealMakeOutboxPayload(payload, dedupeKeyHash);
  if (!sealed.ok) {
    captureOutboxFailure("outbox_encrypt", payload.kind);
    const auditRecorded = await appendDeliveryAudit(
      admin,
      payload,
      dedupeKeyHash,
      "failure",
      { error_code: "outbox_encryption_unavailable" },
    );
    return {
      sent: false,
      reason: "OUTBOX_ENCRYPTION_UNAVAILABLE",
      retryable: false,
      auditRecorded,
      outboxRecorded: false,
    };
  }

  const now = deps.now().toISOString();
  const queued = await deps.store.enqueue({
    userId: payload.userId,
    eventType: payload.kind,
    dedupeKeyHash,
    payloadCiphertext: sealed.data,
    now,
  });
  if (!queued.ok) {
    if (queued.code === "duplicate" && queued.existing?.status === "accepted") {
      const auditRecorded = await appendDeliveryAudit(
        admin,
        payload,
        dedupeKeyHash,
        "pending_confirmation",
        { delivery_id: queued.existing.id, deduped: true, delivery_attempted: false },
      );
      return {
        sent: false,
        accepted: true,
        reason: "DELIVERY_UNCONFIRMED",
        retryable: false,
        status: queued.existing.last_http_status ?? 202,
        deliveryId: queued.existing.id,
        deduped: true,
        auditRecorded,
        outboxRecorded: true,
      };
    }
    if (queued.code === "duplicate" && queued.existing?.status === "delivered") {
      // Record a distinct audit observation: this invocation verified a prior
      // delivery but did not submit a second notification.
      const auditRecorded = await appendDeliveryAudit(
        admin,
        payload,
        dedupeKeyHash,
        "success",
        { delivery_id: queued.existing.id, deduped: true, delivery_attempted: false },
      );
      return {
        sent: true,
        accepted: true,
        status: queued.existing.last_http_status ?? 200,
        deliveryId: queued.existing.id,
        deduped: true,
        auditRecorded,
        outboxRecorded: true,
      };
    }
    if (queued.code === "database") captureOutboxFailure("outbox_enqueue", payload.kind);
    return {
      sent: false,
      reason: queued.code === "duplicate" ? "ALREADY_QUEUED" : "OUTBOX_WRITE_FAILED",
      retryable: queued.code === "database",
      ...(queued.existing ? { deliveryId: queued.existing.id } : {}),
      auditRecorded: false,
      outboxRecorded: queued.code === "duplicate",
    };
  }

  const webhookUrl = webhookUrlForKind(payload.kind);
  if (!webhookUrl) {
    const outboxRecorded = await markUnattemptedFailure({
      store: deps.store,
      row: queued.data,
      errorCode: "webhook_not_configured",
      now: deps.now().toISOString(),
      kind: payload.kind,
    });
    const auditRecorded = await appendDeliveryAudit(
      admin,
      payload,
      dedupeKeyHash,
      "pending_confirmation",
      { delivery_id: queued.data.id, reason: "webhook_not_configured" },
    );
    return {
      sent: false,
      reason: "WEBHOOK_NOT_CONFIGURED",
      retryable: false,
      deliveryId: queued.data.id,
      auditRecorded,
      outboxRecorded,
    };
  }

  const preflightRecorded = await appendDeliveryAudit(
    admin,
    payload,
    dedupeKeyHash,
    "pending_confirmation",
    { delivery_id: queued.data.id },
  );
  if (!preflightRecorded) {
    const outboxRecorded = await markUnattemptedFailure({
      store: deps.store,
      row: queued.data,
      errorCode: "audit_write_failed",
      now: deps.now().toISOString(),
      kind: payload.kind,
    });
    return {
      sent: false,
      reason: "AUDIT_WRITE_FAILED",
      retryable: true,
      deliveryId: queued.data.id,
      auditRecorded: false,
      outboxRecorded,
    };
  }

  return deliverClaimedMakeNotification({
    admin,
    payload,
    row: queued.data,
    webhookUrl,
    dedupeKeyHash,
    deps,
  });
}

/** Explicit authenticated-operator replay. Never called from a cron. */
export async function replayMakeNotification(
  admin: SupabaseClient,
  row: MakeOutboxRow,
  injected: MakeDeliveryDependencies = {},
): Promise<NotifyResult> {
  const deps = dependencies(admin, injected);
  if (!isMakeOutboxReplayable(row, deps.now().getTime())) {
    return {
      sent: false,
      reason: "NOT_REPLAYABLE",
      retryable: false,
      deliveryId: row.id,
      auditRecorded: false,
      outboxRecorded: true,
    };
  }

  const opened = openMakeOutboxPayload(row);
  if (!opened.ok) {
    captureOutboxFailure("outbox_decrypt", row.event_type);
    const outboxRecorded = await markUnattemptedFailure({
      store: deps.store,
      row,
      errorCode: "payload_decryption_failed",
      now: deps.now().toISOString(),
      kind: row.event_type,
    });
    return {
      sent: false,
      reason: "OUTBOX_ENCRYPTION_UNAVAILABLE",
      retryable: false,
      deliveryId: row.id,
      auditRecorded: false,
      outboxRecorded,
    };
  }

  const webhookUrl = webhookUrlForKind(opened.data.kind);
  if (!webhookUrl) {
    const outboxRecorded = await markUnattemptedFailure({
      store: deps.store,
      row,
      errorCode: "webhook_not_configured",
      now: deps.now().toISOString(),
      kind: opened.data.kind,
    });
    return {
      sent: false,
      reason: "WEBHOOK_NOT_CONFIGURED",
      retryable: false,
      deliveryId: row.id,
      auditRecorded: false,
      outboxRecorded,
    };
  }

  const preflightRecorded = await appendDeliveryAudit(
    admin,
    opened.data,
    row.dedupe_key_hash,
    "pending_confirmation",
    { delivery_id: row.id, replay: true },
  );
  if (!preflightRecorded) {
    return {
      sent: false,
      reason: "AUDIT_WRITE_FAILED",
      retryable: true,
      deliveryId: row.id,
      auditRecorded: false,
      outboxRecorded: true,
    };
  }

  return deliverClaimedMakeNotification({
    admin,
    payload: opened.data,
    row,
    webhookUrl,
    dedupeKeyHash: row.dedupe_key_hash,
    deps,
  });
}
