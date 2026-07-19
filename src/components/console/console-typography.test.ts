import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Interface Studio publishes the user's chosen faces as CSS custom properties on
 * <body> (see applyInterfaceSettings in src/lib/theme/interface-settings.ts).
 * Only these follow the user's selection.
 */
const INTERFACE_STUDIO_FONT_TOKENS = [
  "--disp",
  "--serif",
  "--sans",
  "--label",
  "--subhead",
  "--narrow",
];

/**
 * `--mono` is defined statically in globals.css and is NOT written by
 * applyInterfaceSettings, so anything using it is frozen to JetBrains Mono no
 * matter what the user picks. Command widgets previously mixed `--mono` and
 * `--narrow` in the same grid, which is why the typography read as
 * unstandardized: some chrome followed the chosen label face and some did not.
 */
const NON_INTERFACE_STUDIO_FONT_TOKENS = ["--mono"];

const CONSOLE_SOURCES = [
  "src/components/console/ConsoleModule.tsx",
  "src/components/console/WidgetGrid.tsx",
  "src/components/console/InteractiveWidgetTile.tsx",
  "src/components/console/WidgetMiniViz.tsx",
  "src/components/console/ConsoleCaptureBar.tsx",
  "src/components/console/FeaturedPhotos.tsx",
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Command widget typography", () => {
  it.each(CONSOLE_SOURCES)(
    "%s resolves every font from an Interface Studio token",
    (relativePath) => {
      const source = readSource(relativePath);
      const declarations = source.match(/fontFamily:\s*"[^"]*"/g) ?? [];

      for (const declaration of declarations) {
        const usesInterfaceStudioToken = INTERFACE_STUDIO_FONT_TOKENS.some((token) =>
          declaration.includes(`var(${token})`),
        );
        expect(
          usesInterfaceStudioToken,
          `${relativePath} has a font declaration that does not follow Interface Studio: ${declaration}`,
        ).toBe(true);
      }
    },
  );

  it.each(CONSOLE_SOURCES)("%s does not freeze widget text to a static face", (relativePath) => {
    const source = readSource(relativePath);
    for (const token of NON_INTERFACE_STUDIO_FONT_TOKENS) {
      expect(
        source.includes(`fontFamily: "var(${token})"`),
        `${relativePath} pins a font to ${token}, which Interface Studio never rewrites`,
      ).toBe(false);
    }
  });

  it("keeps the token list in sync with what Interface Studio actually writes", async () => {
    // Guards the premise of this whole file: if applyInterfaceSettings stops
    // writing one of these, the allowlist above is silently wrong.
    const settingsSource = readSource("src/lib/theme/interface-settings.ts");
    for (const token of INTERFACE_STUDIO_FONT_TOKENS) {
      expect(
        settingsSource.includes(`"${token}"`),
        `applyInterfaceSettings no longer writes ${token}`,
      ).toBe(true);
    }
  });
});
