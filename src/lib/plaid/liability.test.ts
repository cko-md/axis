import { describe, expect, it } from "vitest";
import { normalizeLiabilities, type AccountSummary } from "./liability";

const NOW = Date.parse("2026-07-14T15:00:00.000Z");

const accounts: Record<string, AccountSummary> = {
  acc_credit: { name: "Chase Sapphire", balanceCurrent: 1240.5, currency: "USD" },
  acc_student: { name: "Sallie Mae", balanceCurrent: 18000, currency: "USD" },
};

describe("normalizeLiabilities", () => {
  it("joins credit + student entries to their accounts with provenance", () => {
    const out = normalizeLiabilities(
      {
        credit: [{ account_id: "acc_credit", last_payment_amount: 200, next_payment_due_date: "2026-08-01", is_overdue: false }],
        student: [{ account_id: "acc_student", is_overdue: true }],
      },
      accounts,
      { now: NOW },
    );
    expect(out).toHaveLength(2);
    const credit = out.find((l) => l.type === "credit")!;
    expect(credit.name).toBe("Chase Sapphire");
    expect(credit.balanceCurrent).toBe(1240.5);
    expect(credit.lastPaymentAmount).toBe(200);
    expect(credit.nextPaymentDueDate).toBe("2026-08-01");
    expect(credit.isOverdue).toBe(false);
    expect(credit.provenance.provider).toBe("plaid");
    expect(credit.freshness).toBe("fresh");

    const student = out.find((l) => l.type === "student")!;
    expect(student.isOverdue).toBe(true);
    expect(student.balanceCurrent).toBe(18000);
  });

  it("rejects a liability without an account/currency binding", () => {
    expect(() => normalizeLiabilities(
      { mortgage: [{ account_id: "unknown" }] },
      {},
      { now: NOW },
    )).toThrow("PLAID_LIABILITY_CURRENCY_UNAVAILABLE");
  });

  it("returns [] when there are no liabilities", () => {
    expect(normalizeLiabilities({}, accounts, { now: NOW })).toEqual([]);
  });

  it("rejects payment precision that is not exact at the currency boundary", () => {
    expect(() => normalizeLiabilities(
      { credit: [{ account_id: "acc_credit", last_payment_amount: 0.1 + 0.2 }] },
      accounts,
      { now: NOW },
    )).toThrow("PLAID_LIABILITY_AMOUNT_INVALID");
  });
});
