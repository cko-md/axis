import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PoemSourceNotice } from "./PoemSourceNotice";

describe("PoemSourceNotice", () => {
  it("visibly identifies the bundled fallback", () => {
    const html = renderToStaticMarkup(<PoemSourceNotice source="local" />);

    expect(html).toContain('role="status"');
    expect(html).toContain("PoetryDB unavailable — showing a bundled poem.");
  });

  it("does not label a live provider response as degraded", () => {
    const html = renderToStaticMarkup(<PoemSourceNotice source="poetrydb" />);

    expect(html).toBe("");
  });
});
