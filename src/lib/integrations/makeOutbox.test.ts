import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMakeOutboxReplayable,
  makeOutboxDedupeHash,
  makeOutboxFailureStatus,
  openMakeOutboxPayload,
  sealMakeOutboxPayload,
  toMakeOutboxPublicItem,
  type MakeNotificationPayload,
  type MakeOutboxRow,
} from "./makeOutbox";

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(() => "11".repeat(32)),
}));

const payload: MakeNotificationPayload = {
  idempotencyKey: "bill:user:merchant:2026-07-15",
  kind: "bill_reminder",
  userId: "user-1",
  to: "private@example.com",
  subject: "Private bill",
  bodyText: "A private financial message",
  meta: { amount: 42.5 },
};

function row(ciphertext: string): MakeOutboxRow {
  return {
    id: "delivery-1",
    user_id: payload.userId,
    provider: "make",
    event_type: payload.kind,
    dedupe_key_hash: makeOutboxDedupeHash(payload.userId, payload.idempotencyKey),
    payload_ciphertext: ciphertext,
    status: "failed",
    attempt_count: 1,
    last_error_code: "network",
    last_http_status: null,
    claim_token: null,
    locked_at: null,
    delivered_at: null,
    created_at: "2026-07-15T12:00:00.000Z",
    updated_at: "2026-07-15T12:00:00.000Z",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Make delivery outbox", () => {
  it("hashes dedupe keys without retaining their plaintext", () => {
    const hash = makeOutboxDedupeHash(payload.userId, payload.idempotencyKey);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("merchant");
    expect(hash).toBe(makeOutboxDedupeHash(payload.userId, payload.idempotencyKey));
  });

  it("round-trips an authenticated encrypted payload", () => {
    const hash = makeOutboxDedupeHash(payload.userId, payload.idempotencyKey);
    const sealed = sealMakeOutboxPayload(payload, hash);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.data).not.toContain(payload.to);
    expect(sealed.data).not.toContain(payload.bodyText);
    expect(openMakeOutboxPayload(row(sealed.data))).toEqual({ ok: true, data: payload });
  });

  it("fails closed when ciphertext or authenticated ownership context changes", () => {
    const hash = makeOutboxDedupeHash(payload.userId, payload.idempotencyKey);
    const sealed = sealMakeOutboxPayload(payload, hash);
    if (!sealed.ok) throw new Error("test setup failed");

    const tampered = row(`${sealed.data.slice(0, -2)}AA`);
    expect(openMakeOutboxPayload(tampered).ok).toBe(false);

    const wrongOwner = { ...row(sealed.data), user_id: "other-user" };
    expect(openMakeOutboxPayload(wrongOwner).ok).toBe(false);
  });

  it("moves the third failed provider attempt to dead-letter", () => {
    expect(makeOutboxFailureStatus(1)).toBe("failed");
    expect(makeOutboxFailureStatus(2)).toBe("failed");
    expect(makeOutboxFailureStatus(3)).toBe("dead_letter");
  });

  it("allows explicit replay of failures and stale claims only", () => {
    const base = row("ciphertext");
    expect(isMakeOutboxReplayable(base, Date.parse("2026-07-15T12:10:00Z"))).toBe(true);
    expect(isMakeOutboxReplayable({ ...base, status: "delivered" })).toBe(false);
    expect(isMakeOutboxReplayable({
      ...base,
      status: "pending",
      locked_at: "2026-07-15T12:08:00Z",
    }, Date.parse("2026-07-15T12:10:00Z"))).toBe(false);
    expect(isMakeOutboxReplayable({
      ...base,
      status: "pending",
      locked_at: "2026-07-15T12:00:00Z",
    }, Date.parse("2026-07-15T12:10:00Z"))).toBe(true);
  });

  it("never exposes ciphertext, owner, dedupe hash, or claim token to clients", () => {
    const claimed: MakeOutboxRow = {
      ...row("private-ciphertext"),
      status: "pending",
      claim_token: "private-claim",
      locked_at: "2026-07-15T12:00:00Z",
    };
    const publicItem = toMakeOutboxPublicItem(
      claimed,
      Date.parse("2026-07-15T12:10:00Z"),
    );
    const serialized = JSON.stringify(publicItem);
    expect(serialized).not.toContain("private-ciphertext");
    expect(serialized).not.toContain("private-claim");
    expect(serialized).not.toContain(payload.userId);
    expect(serialized).not.toContain("dedupe_key_hash");
    expect(publicItem.replayable).toBe(true);
  });
});
