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
    expect(a.balanceAvailable).toBe(1200);
    expect(a.currency).toBe("USD");
    expect(a.provenance.provider).toBe("plaid");
    expect(a.provenance.retrievedAt).toBe(new Date(NOW).toISOString());
    expect(a.freshness).toBe("fresh"); // just retrieved
  });

  it("defaults missing mask/subtype/type/balances to null", () => {
    const a = normalizeAccount({ name: "Card" }, { now: NOW });
    expect(a.mask).toBeNull();
    expect(a.subtype).toBeNull();
    expect(a.type).toBeNull();
    expect(a.balanceCurrent).toBeNull();
    expect(a.balanceAvailable).toBeNull();
    expect(a.currency).toBe("USD");
  });

  it("honors the account's currency", () => {
    const a = normalizeAccount({ name: "ISA", balances: { current: 500, iso_currency_code: "GBP" } }, { now: NOW });
    expect(a.currency).toBe("GBP");
    expect(a.provenance.currency).toBe("GBP");
  });

  it("coerces non-finite balances to null (never NaN)", () => {
    const a = normalizeAccount({ name: "X", balances: { current: Number.NaN } }, { now: NOW });
    expect(a.balanceCurrent).toBeNull();
  });

  it("normalizes a list", () => {
    const list = normalizeAccounts([{ name: "A" }, { name: "B" }], { now: NOW });
    expect(list.map((a) => a.name)).toEqual(["A", "B"]);
  });
});
