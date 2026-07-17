export const TYPOGRAPHY_TOKENS = {
  displayFamily: "--type-display-family",
  headingFamily: "--type-heading-family",
  bodyFamily: "--type-body-family",
  labelFamily: "--type-label-family",
  codeFamily: "--type-code-family",
  displaySize: "--type-display-size",
  titleSize: "--type-title-size",
  headingSize: "--type-heading-size",
  bodySize: "--type-body-size",
  smallSize: "--type-small-size",
  labelSize: "--type-label-size",
  microSize: "--type-micro-size",
  displayLeading: "--type-display-leading",
  headingLeading: "--type-heading-leading",
  bodyLeading: "--type-body-leading",
  labelLeading: "--type-label-leading",
} as const;

export const SURFACE_TOKENS = {
  canvas: "--surface-canvas",
  chrome: "--surface-chrome",
  panel: "--surface-panel",
  raised: "--surface-panel-raised",
  input: "--surface-input",
  overlay: "--surface-overlay",
  borderSubtle: "--border-subtle",
  borderStrong: "--border-strong",
  shadowPanel: "--shadow-panel",
} as const;

export const MOTION_TOKENS = {
  instant: "--motion-duration-instant",
  fast: "--motion-duration-fast",
  base: "--motion-duration-base",
  deliberate: "--motion-duration-deliberate",
  ambient: "--motion-duration-ambient",
  standardEase: "--motion-ease-standard",
  enterEase: "--motion-ease-enter",
  exitEase: "--motion-ease-exit",
} as const;

export const INTERACTION_TOKENS = {
  onAccent: "--on-accent",
  focusIndicator: "--focus-indicator",
  focusRing: "--focus-ring",
} as const;

export const DESIGN_TOKEN_GROUPS = {
  typography: TYPOGRAPHY_TOKENS,
  surfaces: SURFACE_TOKENS,
  motion: MOTION_TOKENS,
  interaction: INTERACTION_TOKENS,
} as const;

export function cssToken(token: string): string {
  return `var(${token})`;
}

export function allDesignTokens(): string[] {
  return Object.values(DESIGN_TOKEN_GROUPS).flatMap((group) => Object.values(group));
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance for a six-digit sRGB hex color. */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid six-digit hex color: ${hex}`);
  const red = linearChannel(Number.parseInt(hex.slice(1, 3), 16));
  const green = linearChannel(Number.parseInt(hex.slice(3, 5), 16));
  const blue = linearChannel(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio, where 4.5 is AA for normal text and 3 is UI contrast. */
export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}
