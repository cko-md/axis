import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Save } from "lucide-react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Button } from "./Button";
import { Seg } from "./Seg";

describe("shared control accessibility contracts", () => {
  it("keeps a loading button's command name and exposes busy/disabled state", () => {
    const html = renderToStaticMarkup(
      <Button loading>
        <Save size={14} aria-hidden />
        Sync profile
      </Button>,
    );

    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Sync profile");
    expect(html).toContain("aria-hidden=\"true\"");
    expect(html).toContain("axis-button-spinner");
    expect(html).toContain("svg:not(.axis-button-spinner)");
    expect(html).not.toContain("<span>");
  });

  it("keeps icon and label children in the button's flex layout", () => {
    const html = renderToStaticMarkup(
      <Button>
        <Save size={14} aria-hidden />
        Save profile
      </Button>,
    );

    expect(html).toContain("inline-flex");
    expect(html).toContain("gap-2");
    expect(html).not.toContain("<span>");
  });

  it("names segmented controls and exposes the selected option without color", () => {
    const html = renderToStaticMarkup(
      <Seg
        ariaLabel="Color theme"
        options={[{ label: "Dark", value: "dark" }, { label: "Light", value: "light" }]}
        value="light"
        onChange={vi.fn()}
      />,
    );

    expect(html).toContain("role=\"group\"");
    expect(html).toContain("aria-label=\"Color theme\"");
    expect(html).toContain("aria-pressed=\"false\"");
    expect(html).toContain("aria-pressed=\"true\"");
  });

  it("supports an aria-labelledby accessible name", () => {
    const html = renderToStaticMarkup(
      <div>
        <h2 id="density-heading">Density</h2>
        <Seg
          aria-labelledby="density-heading"
          options={[{ label: "Standard", value: "standard" }, { label: "Compact", value: "compact" }]}
          value="standard"
          onChange={vi.fn()}
        />
      </div>,
    );

    expect(html).toContain("aria-labelledby=\"density-heading\"");
    expect(html).not.toContain("aria-label=\"");
  });

  it("requires an accessible name in the Seg prop contract", () => {
    type UnnamedSegProps = {
      options: { label: string; value: string }[];
      value: string;
      onChange: (value: string) => void;
    };

    expectTypeOf<UnnamedSegProps>().not.toMatchTypeOf<Parameters<typeof Seg>[0]>();
  });
});
