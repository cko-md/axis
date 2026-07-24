import { describe, expect, it } from "vitest";
import { normalizeTransaction, normalizeTransactions } from "./transaction";

const NOW = Date.parse("2026-07-14T15:00:00.000Z");

describe("normalizeTransaction", () => {
  it("flips the sign so positive = inflow and stamps provenance", () => {
    // Plaid: +42.50 is a debit (money out) → domain -42.50.
    const t = normalizeTransaction(
      { transaction_id: "tx1", name: "Coffee", merchant_name: "Blue Bottle", amount: 42.5, date: "2026-07-13", pending: false, iso_currency_code: "USD" },
      { now: NOW },
    );
    expect(t.amount).toBe(-42.5);
    expect(t.merchantName).toBe("Blue Bottle");
    expect(t.provenance.provider).toBe("plaid");
    expect(t.provenance.providerRecordId).toBe("tx1");
    expect(t.provenance.effectiveAt).toBe("2026-07-13");
  });

  it("treats a Plaid credit (negative) as a domain inflow (positive)", () => {
    const t = normalizeTransaction({ transaction_id: "tx2", name: "Payroll", amount: -2000, date: "2026-07-13", iso_currency_code: "USD" }, { now: NOW });
    expect(t.amount).toBe(2000);
  });

  it("rejects provider precision that is not exactly representable", () => {
    expect(() => normalizeTransaction(
      { transaction_id: "tx3", name: "x", amount: 0.1 + 0.2, date: "2026-07-13", iso_currency_code: "USD" },
      { now: NOW },
    )).toThrow("PLAID_TRANSACTION_AMOUNT_INVALID");
  });

  it("rejects missing provider currency", () => {
    expect(() => normalizeTransaction(
      { transaction_id: "tx4", name: "x", amount: 1, date: "2026-07-13" },
      { now: NOW },
    )).toThrow("PLAID_TRANSACTION_CURRENCY_UNAVAILABLE");
  });

  it("normalizes a list", () => {
    const list = normalizeTransactions(
      [
        { transaction_id: "a", name: "A", amount: 1, date: "2026-07-13", iso_currency_code: "USD" },
        { transaction_id: "b", name: "B", amount: 2, date: "2026-07-13", iso_currency_code: "USD" },
      ],
      { now: NOW },
    );
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
