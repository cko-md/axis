import type { NotifyResult } from "./notifyViaMake";

/**
 * Delivery state for a finance job. A failed provider delivery remains visible
 * to the caller so a cron cannot report a false successful run.
 */
export type FinanceNotificationOutcome = {
  attempted: number;
  failed: number;
  results: NotifyResult[];
};

export function noNotifications(): FinanceNotificationOutcome {
  return { attempted: 0, failed: 0, results: [] };
}

export function notificationOutcome(results: NotifyResult[]): FinanceNotificationOutcome {
  return {
    attempted: results.length,
    // A claimed delivery without durable outbox and audit records is not a
    // complete financial notification outcome; it cannot be replayed/audited.
    failed: results.filter((result) => !result.sent || !result.outboxRecorded || !result.auditRecorded).length,
    results,
  };
}

export function mergeNotificationOutcomes(...outcomes: FinanceNotificationOutcome[]): FinanceNotificationOutcome {
  return {
    attempted: outcomes.reduce((total, outcome) => total + outcome.attempted, 0),
    failed: outcomes.reduce((total, outcome) => total + outcome.failed, 0),
    results: outcomes.flatMap((outcome) => outcome.results),
  };
}
