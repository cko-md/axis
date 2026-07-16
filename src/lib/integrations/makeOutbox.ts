import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { optionalEnv } from "@/lib/env";
import { fail, ok, type Result } from "@/lib/integrations/types";

export const MAKE_NOTIFICATION_KINDS = [
  "daily_brief",
  "weekly_recap",
  "bill_reminder",
  "budget_alert",
  "anomaly_alert",
  "subscription_audit",
] as const;

export type MakeNotificationKind = (typeof MAKE_NOTIFICATION_KINDS)[number];

export type MakeNotificationPayload = {
  idempotencyKey: string;
  kind: MakeNotificationKind;
  userId: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  meta?: Record<string, unknown>;
};

export type MakeOutboxStatus = "pending" | "delivered" | "failed" | "dead_letter";

export type MakeOutboxMetadataRow = {
  id: string;
  provider: "make";
  event_type: MakeNotificationKind;
  status: MakeOutboxStatus;
  attempt_count: number;
  last_error_code: string | null;
  last_http_status: number | null;
  locked_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MakeOutboxRow = MakeOutboxMetadataRow & {
  user_id: string;
  dedupe_key_hash: string;
  payload_ciphertext: string;
  claim_token: string | null;
};

export type MakeOutboxPublicItem = MakeOutboxMetadataRow & {
  replayable: boolean;
};

export type MakeOutboxCompletion =
  | { accepted: true; status: number }
  | { accepted: false; errorCode: string; status?: number };

export type MakeOutboxStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "duplicate" | "database" | "claim_conflict"; existing?: MakeOutboxRow };

export type MakeOutboxStore = {
  enqueue(input: {
    userId: string;
    eventType: MakeNotificationKind;
    dedupeKeyHash: string;
    payloadCiphertext: string;
    now: string;
  }): Promise<MakeOutboxStoreResult<MakeOutboxRow>>;
  getOwned(id: string, userId: string): Promise<MakeOutboxStoreResult<MakeOutboxRow | null>>;
  claim(input: {
    row: MakeOutboxRow;
    claimToken: string;
    now: string;
  }): Promise<MakeOutboxStoreResult<MakeOutboxRow>>;
  complete(input: {
    row: MakeOutboxRow;
    claimToken: string;
    completion: MakeOutboxCompletion;
    now: string;
  }): Promise<MakeOutboxStoreResult<MakeOutboxRow>>;
  failWithoutAttempt(input: {
    row: MakeOutboxRow;
    errorCode: string;
    now: string;
  }): Promise<MakeOutboxStoreResult<MakeOutboxRow>>;
};

const OUTBOX_INFO = Buffer.from("axis:make-delivery-outbox:v1", "utf8");
const OUTBOX_SALT = Buffer.from("axis:purpose-separated-encryption", "utf8");
const ENVELOPE_VERSION = "v1";
export const MAKE_OUTBOX_MAX_ATTEMPTS = 3;
export const MAKE_OUTBOX_STALE_CLAIM_MS = 5 * 60 * 1000;

function outboxKey(): Buffer | null {
  const keyHex = optionalEnv("PASSKEY_ENCRYPTION_KEY");
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) return null;
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(keyHex, "hex"), OUTBOX_SALT, OUTBOX_INFO, 32),
  );
}

function authenticatedContext(userId: string, eventType: MakeNotificationKind, hash: string) {
  return Buffer.from(`${userId}:${eventType}:${hash}`, "utf8");
}

export function makeOutboxDedupeHash(userId: string, idempotencyKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}:make:${idempotencyKey}`, "utf8")
    .digest("hex");
}

export function sealMakeOutboxPayload(
  payload: MakeNotificationPayload,
  dedupeKeyHash: string,
): Result<string> {
  const key = outboxKey();
  if (!key) {
    return fail("provider_error", "Make outbox encryption is unavailable", {
      provider: "make",
      retryable: false,
    });
  }
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(authenticatedContext(payload.userId, payload.kind, dedupeKeyHash));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return ok([
      ENVELOPE_VERSION,
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(":"));
  } catch {
    return fail("provider_error", "Make outbox payload could not be encrypted", {
      provider: "make",
      retryable: false,
    });
  }
}

function isMakeNotificationPayload(value: unknown): value is MakeNotificationPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<MakeNotificationPayload>;
  return (
    typeof payload.idempotencyKey === "string" &&
    payload.idempotencyKey.length > 0 &&
    typeof payload.userId === "string" &&
    payload.userId.length > 0 &&
    typeof payload.to === "string" &&
    typeof payload.subject === "string" &&
    typeof payload.bodyText === "string" &&
    MAKE_NOTIFICATION_KINDS.includes(payload.kind as MakeNotificationKind)
  );
}

export function openMakeOutboxPayload(row: MakeOutboxRow): Result<MakeNotificationPayload> {
  const key = outboxKey();
  if (!key) {
    return fail("provider_error", "Make outbox encryption is unavailable", {
      provider: "make",
      retryable: false,
    });
  }
  try {
    const [version, ivB64, tagB64, ciphertextB64] = row.payload_ciphertext.split(":");
    if (version !== ENVELOPE_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
      throw new Error("invalid envelope");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAAD(authenticatedContext(row.user_id, row.event_type, row.dedupe_key_hash));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const payload: unknown = JSON.parse(plaintext);
    if (!isMakeNotificationPayload(payload)) throw new Error("invalid payload");
    if (payload.userId !== row.user_id || payload.kind !== row.event_type) {
      throw new Error("context mismatch");
    }
    return ok(payload);
  } catch {
    return fail("provider_error", "Make outbox payload could not be decrypted", {
      provider: "make",
      retryable: false,
    });
  }
}

export function makeOutboxFailureStatus(attemptCount: number): MakeOutboxStatus {
  return attemptCount >= MAKE_OUTBOX_MAX_ATTEMPTS ? "dead_letter" : "failed";
}

export function isMakeOutboxReplayable(row: MakeOutboxMetadataRow, nowMs = Date.now()): boolean {
  if (row.status === "failed" || row.status === "dead_letter") return true;
  if (row.status !== "pending") return false;
  if (!row.locked_at) return true;
  const lockedAt = Date.parse(row.locked_at);
  return Number.isNaN(lockedAt) || nowMs - lockedAt >= MAKE_OUTBOX_STALE_CLAIM_MS;
}

export function toMakeOutboxPublicItem(
  row: MakeOutboxMetadataRow,
  nowMs = Date.now(),
): MakeOutboxPublicItem {
  return {
    id: row.id,
    provider: row.provider,
    event_type: row.event_type,
    status: row.status,
    attempt_count: row.attempt_count,
    last_error_code: row.last_error_code,
    last_http_status: row.last_http_status,
    locked_at: row.locked_at,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    replayable: isMakeOutboxReplayable(row, nowMs),
  };
}

const OUTBOX_SELECT =
  "id, user_id, provider, event_type, dedupe_key_hash, payload_ciphertext, status, attempt_count, last_error_code, last_http_status, claim_token, locked_at, delivered_at, created_at, updated_at";

function asRow(value: unknown): MakeOutboxRow {
  return value as MakeOutboxRow;
}

export function createSupabaseMakeOutboxStore(admin: SupabaseClient): MakeOutboxStore {
  return {
    async enqueue(input) {
      const { data, error } = await admin
        .from("integration_delivery_outbox")
        .insert({
          user_id: input.userId,
          provider: "make",
          event_type: input.eventType,
          dedupe_key_hash: input.dedupeKeyHash,
          payload_ciphertext: input.payloadCiphertext,
          status: "pending",
          attempt_count: 0,
          updated_at: input.now,
        })
        .select(OUTBOX_SELECT)
        .maybeSingle();
      if (!error && data) return { ok: true, data: asRow(data) };
      if (error?.code === "23505") {
        const existing = await admin
          .from("integration_delivery_outbox")
          .select(OUTBOX_SELECT)
          .eq("user_id", input.userId)
          .eq("provider", "make")
          .eq("dedupe_key_hash", input.dedupeKeyHash)
          .maybeSingle();
        return {
          ok: false,
          code: "duplicate",
          ...(existing.data ? { existing: asRow(existing.data) } : {}),
        };
      }
      return { ok: false, code: "database" };
    },

    async getOwned(id, userId) {
      const { data, error } = await admin
        .from("integration_delivery_outbox")
        .select(OUTBOX_SELECT)
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      return error
        ? { ok: false, code: "database" }
        : { ok: true, data: data ? asRow(data) : null };
    },

    async claim({ row, claimToken, now }) {
      let query = admin
        .from("integration_delivery_outbox")
        .update({
          status: "pending",
          attempt_count: row.attempt_count + 1,
          claim_token: claimToken,
          locked_at: now,
          last_error_code: null,
          last_http_status: null,
          delivered_at: null,
          updated_at: now,
        })
        .eq("id", row.id)
        .eq("user_id", row.user_id)
        .eq("status", row.status)
        .eq("attempt_count", row.attempt_count);
      query = row.claim_token
        ? query.eq("claim_token", row.claim_token)
        : query.is("claim_token", null);
      const { data, error } = await query.select(OUTBOX_SELECT).maybeSingle();
      if (error) return { ok: false, code: "database" };
      return data
        ? { ok: true, data: asRow(data) }
        : { ok: false, code: "claim_conflict" };
    },

    async complete({ row, claimToken, completion, now }) {
      const patch = completion.accepted
        ? {
            status: "delivered",
            last_error_code: null,
            last_http_status: completion.status,
            claim_token: null,
            locked_at: null,
            delivered_at: now,
            updated_at: now,
          }
        : {
            status: makeOutboxFailureStatus(row.attempt_count),
            last_error_code: completion.errorCode,
            last_http_status: completion.status ?? null,
            claim_token: null,
            locked_at: null,
            delivered_at: null,
            updated_at: now,
          };
      const { data, error } = await admin
        .from("integration_delivery_outbox")
        .update(patch)
        .eq("id", row.id)
        .eq("user_id", row.user_id)
        .eq("claim_token", claimToken)
        .select(OUTBOX_SELECT)
        .maybeSingle();
      if (error) return { ok: false, code: "database" };
      return data
        ? { ok: true, data: asRow(data) }
        : { ok: false, code: "claim_conflict" };
    },

    async failWithoutAttempt({ row, errorCode, now }) {
      const { data, error } = await admin
        .from("integration_delivery_outbox")
        .update({
          status: "failed",
          last_error_code: errorCode,
          last_http_status: null,
          claim_token: null,
          locked_at: null,
          delivered_at: null,
          updated_at: now,
        })
        .eq("id", row.id)
        .eq("user_id", row.user_id)
        .eq("attempt_count", row.attempt_count)
        .select(OUTBOX_SELECT)
        .maybeSingle();
      if (error) return { ok: false, code: "database" };
      return data
        ? { ok: true, data: asRow(data) }
        : { ok: false, code: "claim_conflict" };
    },
  };
}
