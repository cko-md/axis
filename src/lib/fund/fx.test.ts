import { describe, expect, it } from "vitest";
import { convertMinorUnits, convertMoney, type FxRate } from "./fx";

const usdToEur: FxRate = {
  base: "USD",
  quote: "EUR",
  rate: 0.92,
  provider: "ecb",
  retrievedAt: "2026-07-15T12:00:00Z",
};

describe("convertMinorUnits", () => {
  it("same-currency identity needs no rate and carries no provenance", () => {
    const r = convertMinorUnits(4250, "USD", "usd");
    expect(r).toEqual({
      ok: true,
      value: { amountMinor: 4250, currency: "USD", rate: null, inverted: false, provenance: null },
    });
  });

  it("cross-currency without a rate is an error, never a 1.0 fallback", () => {
    const r = convertMinorUnits(4250, "USD", "EUR");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("missing_rate");
  });

  it("applies a matching rate with a single rounding step", () => {
    // $100.00 -> 10000 minor * 0.92 = 9200 minor = €92.00 exactly.
    const r = convertMinorUnits(10000, "USD", "EUR", usdToEur);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.amountMinor).toBe(9200);
      expect(r.value.currency).toBe("EUR");
      expect(r.value.inverted).toBe(false);
      expect(r.value.provenance).toEqual({
        provider: "ecb",
        retrievedAt: "2026-07-15T12:00:00Z",
        currency: "EUR",
      });
    }
  });

  it("converts $100 at 1.2345 to exactly 12345 minor units (no compounding)", () => {
    const rate: FxRate = { ...usdToEur, quote: "CAD", rate: 1.2345 };
    const r = convertMinorUnits(10000, "USD", "CAD", rate);
    expect(r.ok && r.value.amountMinor).toBe(12345);
  });

  it("reconciles differing exponents: USD -> JPY and USD -> BHD", () => {
    const toJpy: FxRate = { ...usdToEur, quote: "JPY", rate: 155.5 };
    const jpy = convertMinorUnits(10000, "USD", "JPY", toJpy); // $100 -> ¥15550
    expect(jpy.ok && jpy.value.amountMinor).toBe(15550);

    const toBhd: FxRate = { ...usdToEur, quote: "BHD", rate: 0.376 };
    const bhd = convertMinorUnits(10000, "USD", "BHD", toBhd); // $100 -> 37.600 BHD
    expect(bhd.ok && bhd.value.amountMinor).toBe(37600);
  });

  it("uses the inverse of a rate for the reverse direction and flags it", () => {
    const r = convertMinorUnits(9200, "EUR", "USD", usdToEur); // €92 / 0.92 = $100
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.amountMinor).toBe(10000);
      expect(r.value.inverted).toBe(true);
    }
  });

  it("A->B->A round-trip with r then 1/r is within one minor unit", () => {
    for (const amount of [1, 333, 12345, 999999]) {
      const there = convertMinorUnits(amount, "USD", "EUR", usdToEur);
      expect(there.ok).toBe(true);
      if (!there.ok) continue;
      const back = convertMinorUnits(there.value.amountMinor, "EUR", "USD", usdToEur);
      expect(back.ok).toBe(true);
      if (back.ok) expect(Math.abs(back.value.amountMinor - amount)).toBeLessThanOrEqual(1);
    }
  });

  it("rejects a rate whose pair matches neither direction", () => {
    const r = convertMinorUnits(100, "USD", "GBP", usdToEur);
    expect(!r.ok && r.error.code).toBe("rate_pair_mismatch");
  });

  it("rejects non-finite, zero, and negative rates", () => {
    for (const bad of [0, -1.2, Number.NaN, Infinity]) {
      const r = convertMinorUnits(100, "USD", "EUR", { ...usdToEur, rate: bad });
      expect(!r.ok && r.error.code).toBe("invalid_rate");
    }
  });

  it("rejects a non-finite amount", () => {
    const r = convertMinorUnits(Number.NaN, "USD", "EUR", usdToEur);
    expect(!r.ok && r.error.code).toBe("invalid_amount");
  });
});

describe("convertMoney (display boundary)", () => {
  it("converts major units end to end on integer minor units", () => {
    const r = convertMoney("100.00", "USD", "EUR", usdToEur);
    expect(r.ok && r.value.amount).toBe(92);
  });

  it("handles exponent changes at the boundary: $100 -> ¥15550", () => {
    const r = convertMoney(100, "USD", "JPY", { ...usdToEur, quote: "JPY", rate: 155.5 });
    expect(r.ok && r.value.amount).toBe(15550);
  });

  it("propagates errors unchanged", () => {
    const r = convertMoney(100, "USD", "EUR");
    expect(!r.ok && r.error.code).toBe("missing_rate");
  });
});
