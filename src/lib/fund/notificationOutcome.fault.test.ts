import { describe, expect, it } from "vitest";
import type { NotifyResult } from "./notifyViaMake";
import {
  mergeNotificationOutcomes,
  noNotifications,
  notificationOutcome,
} from "./notificationOutcome";

const durableSuccess: NotifyResult = {
  sent: true,
  accepted: true,
  status: 202,
  deliveryId: "delivery-success",
  deduped: false,
  auditRecorded: true,
  outboxRecorded: true,
};

describe("finance notification outcome fault semantics", () => {
  it("treats accepted-but-unaudited or unpersisted delivery as a partial failure", () => {
    const unaudited: NotifyResult = {
      ...durableSuccess,
      deliveryId: "delivery-unaudited",
      auditRecorded: false,
    };
    const unpersisted: NotifyResult = {
      ...durableSuccess,
      deliveryId: "delivery-unpersisted",
      outboxRecorded: false,
    };

    expect(notificationOutcome([durableSuccess, unaudited, unpersisted])).toMatchObject({
      attempted: 3,
      failed: 2,
    });
  });

  it("propagates a typed provider non-delivery as a failure", () => {
    const rejected: NotifyResult = {
      sent: false,
      reason: "DELIVERY_FAILED",
      retryable: true,
      deliveryId: "delivery-rejected",
      auditRecorded: true,
      outboxRecorded: true,
    };

    expect(notificationOutcome([rejected])).toEqual({
      attempted: 1,
      failed: 1,
      results: [rejected],
    });
  });

  it("does not claim a duplicate delivery is complete without audit evidence", () => {
    const dedupedWithoutAudit: NotifyResult = {
      sent: true,
      accepted: true,
      status: 202,
      deliveryId: "delivery-deduped",
      deduped: true,
      auditRecorded: false,
      outboxRecorded: true,
    };

    expect(notificationOutcome([dedupedWithoutAudit]).failed).toBe(1);
  });

  it("merges job outcomes without losing individual delivery evidence", () => {
    const failed: NotifyResult = {
      sent: false,
      reason: "OUTBOX_WRITE_FAILED",
      retryable: true,
      auditRecorded: false,
      outboxRecorded: false,
    };

    expect(mergeNotificationOutcomes(
      noNotifications(),
      notificationOutcome([durableSuccess]),
      notificationOutcome([failed]),
    )).toEqual({
      attempted: 2,
      failed: 1,
      results: [durableSuccess, failed],
    });
  });
});
