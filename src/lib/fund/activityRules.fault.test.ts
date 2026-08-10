import { describe, expect, it } from "vitest";
import { assessActivityAnomaly } from "./activityRules";

describe("provider activity anomaly availability", () => {
  it.each([null, "USX"])(
    "marks explicit provider currency %j unavailable",
    (currency) => {
      expect(assessActivityAnomaly({
        id: "today",
        merchantName: "Acme",
        amount: "-200.00",
        currency,
      }, [])).toMatchObject({
        available: false,
        amountMinor: null,
        flagged: false,
      });
    },
  );
});
