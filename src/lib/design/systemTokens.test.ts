import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS } from "@/lib/theme/interface-settings";
import {
  allDesignTokens,
  contrastRatio,
  cssToken,
  INTERACTION_TOKENS,
  MOTION_TOKENS,
  relativeLuminance,
  SURFACE_TOKENS,
  TYPOGRAPHY_TOKENS,
} from "./systemTokens";

const globals = readFileSync("src/app/globals.css", "utf8");

function cssBlock(marker: string): string {
  const start = globals.indexOf(marker);
  if (start < 0) throw new Error(`Missing CSS block: ${marker}`);
  const open = globals.indexOf("{", start);
  const close = globals.indexOf("\n}", open);
  if (open < 0 || close < 0) throw new Error(`Unterminated CSS block: ${marker}`);
  return globals.slice(open + 1, close);
}

function hexDeclaration(block: string, token: string): string {
  const match = block.match(new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`Missing six-digit ${token} declaration`);
  return match[1].toLowerCase();
}

const rootBlock = cssBlock(":root {");
const themeBlocks = {
  dark: rootBlock,
  dim: cssBlock("html.dim {"),
  slate: cssBlock("html.slate {"),
  light: cssBlock("html.light {"),
} as const;

const solidSurfaceTokens = ["--bg", "--surface", "--surface-2", "--surface-3"];

describe("design-system tokens", () => {
  it("declares every exported semantic token in the global theme", () => {
    for (const token of allDesignTokens()) {
      expect(globals, `${token} is exported but not declared`).toContain(`${token}:`);
    }
  });

  it("keeps the token families distinct and addressable as CSS variables", () => {
    const tokens = allDesignTokens();
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(cssToken(TYPOGRAPHY_TOKENS.bodySize)).toBe("var(--type-body-size)");
    expect(cssToken(SURFACE_TOKENS.panel)).toBe("var(--surface-panel)");
    expect(cssToken(MOTION_TOKENS.base)).toBe("var(--motion-duration-base)");
    expect(cssToken(INTERACTION_TOKENS.focusIndicator)).toBe("var(--focus-indicator)");
  });

  it("resolves semantic font families on body, where runtime face variables are set", () => {
    const bodyBlock = cssBlock("body {\n  /* Re-declare font stacks");
    for (const token of [
      TYPOGRAPHY_TOKENS.displayFamily,
      TYPOGRAPHY_TOKENS.headingFamily,
      TYPOGRAPHY_TOKENS.bodyFamily,
      TYPOGRAPHY_TOKENS.labelFamily,
      TYPOGRAPHY_TOKENS.codeFamily,
    ]) {
      expect(bodyBlock).toContain(`${token}:`);
      expect(rootBlock).not.toContain(`${token}:`);
    }
  });

  it("reduces every semantic duration when reduced motion is requested", () => {
    const reduced = globals.slice(globals.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const token of Object.values(MOTION_TOKENS).filter((token) => token.includes("duration"))) {
      expect(reduced, `${token} must collapse in the global reduced-motion contract`).toContain(`${token}: 0.01ms`);
    }
  });

  it.each(["dim", "slate", "light"])("retains the %s theme selector", (theme) => {
    expect(globals).toContain(`html.${theme} {`);
  });

  it("keeps normal-size faint text at AA contrast on every solid theme surface", () => {
    for (const [theme, block] of Object.entries(themeBlocks)) {
      const faint = hexDeclaration(block, "--ink-faint");
      for (const surfaceToken of solidSurfaceTokens) {
        const surface = hexDeclaration(block, surfaceToken);
        expect(
          contrastRatio(faint, surface),
          `${theme} ${faint} on ${surfaceToken} ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps primary-control text AA across every selectable accent", () => {
    const foreground = hexDeclaration(rootBlock, "--on-accent");
    expect(themeBlocks.light).not.toContain("--on-accent:");
    for (const [preset, colors] of Object.entries(ACCENT_PRESETS)) {
      expect(contrastRatio(foreground, colors.accent), `${preset} accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(foreground, colors.accentBright), `${preset} hover accent`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses theme ink, not a selectable accent, for the focus indicator", () => {
    expect(rootBlock).toContain("--focus-indicator: var(--ink)");
    expect(globals).toContain("outline: 2px solid var(--focus-indicator)");
    expect(globals).not.toContain("outline: 2px solid var(--accent);");
    for (const [theme, block] of Object.entries(themeBlocks)) {
      const ink = hexDeclaration(block, "--ink");
      const canvas = hexDeclaration(block, "--bg");
      expect(contrastRatio(ink, canvas), `${theme} focus indicator`).toBeGreaterThanOrEqual(3);
    }
  });

  it("implements the WCAG luminance helpers deterministically", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(() => relativeLuminance("white")).toThrow(/six-digit hex/i);
  });
});
