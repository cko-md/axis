import { describe, expect, it } from "vitest";
import { normalizeAccount, normalizeAccounts } from "./account";

const NOW = Date.parse("2026-07-14T15:00:00.000Z");

describe("normalizeAccount", () => {
  it("normalizes balances + stamps provenance and freshness", () => {
    const a = normalizeAccount(
      { name: "Everyday Checking", mask: "0000", subtype: "checking", type: "depository", balances: { current: 1234.56, available: 1200, iso_currency_code: "USD" } },
      { now: NOW },
    );
    expect(a.name).toBe("Everyday Checking");
    expect(a.balanceCurrent).toBe(1234.56);
    expect(a.balanceCurrentMinor).toBe(123456);
    expect(a.balanceAvailable).toBe(1200);
    expect(a.currency).toBe("USD");
    expect(a.provenance.provider).toBe("plaid");
    expect(a.provenance.retrievedAt).toBe(new Date(NOW).toISOString());
    expect(a.freshness).toBe("fresh"); // just retrieved
  });

  it("rejects a provider account without explicit currency", () => {
    expect(() => normalizeAccount({ name: "Card" }, { now: NOW }))
      .toThrow("PLAID_ACCOUNT_CURRENCY_UNAVAILABLE");
  });

  it("honors the account's currency", () => {
    const a = normalizeAccount({ name: "ISA", balances: { current: 500, iso_currency_code: "GBP" } }, { now: NOW });
    expect(a.currency).toBe("GBP");
    expect(a.provenance.currency).toBe("GBP");
  });

  it("rejects non-finite balances instead of fabricating null", () => {
    expect(() => normalizeAccount(
      { name: "X", balances: { current: Number.NaN, iso_currency_code: "USD" } },
      { now: NOW },
    )).toThrow("PLAID_ACCOUNT_AMOUNT_INVALID");
  });

  it("normalizes a list", () => {
    const list = normalizeAccounts([
      { name: "A", balances: { current: null, iso_currency_code: "USD" } },
      { name: "B", balances: { current: null, iso_currency_code: "USD" } },
    ], { now: NOW });
    expect(list.map((a) => a.name)).toEqual(["A", "B"]);
  });
});
