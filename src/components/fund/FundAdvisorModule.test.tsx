import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdvisorEvidenceView } from "./FundAdvisorModule";

describe("AdvisorEvidenceView", () => {
  it("renders verified server facts and their tool section", () => {
    const html = renderToStaticMarkup(
      <AdvisorEvidenceView evidence={[{
        source: "compute_safe_to_invest",
        title: "Safe-to-invest calculation",
        facts: [
          "Cash on hand $1,000.00 minus bills $250.00 and buffer $100.00 equals $650.00 safe to invest.",
        ],
      }]} />,
    );

    expect(html).toContain("Verified evidence");
    expect(html).toContain("Safe-to-invest calculation");
    expect(html).toContain("$650.00 safe to invest");
  });

  it("renders no shell when there is no verified evidence", () => {
    expect(renderToStaticMarkup(
      <AdvisorEvidenceView evidence={[]} />,
    )).toBe("");
  });
});
