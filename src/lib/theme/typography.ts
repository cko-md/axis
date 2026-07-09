import type { BodyFace, DisplayFace, LabelFace, SubheadFace } from "@/lib/theme/interface-settings";

/** Fontshare + loaded Google faces — CSS font-family stacks */
export const DISPLAY_STACKS: Record<DisplayFace, string> = {
  array: '"Array", var(--font-bebas, "Bebas Neue"), sans-serif',
  tanker: '"Tanker", var(--font-bebas), sans-serif',
  neco: '"Neco", var(--font-grotesk), sans-serif',
  nippo: '"Nippo", var(--font-narrow), sans-serif',
  telma: '"Telma", var(--font-serif), serif',
  boxing: '"Boxing", var(--font-bebas), sans-serif',
  kola: '"Kola", var(--font-serif), serif',
  instrument: 'var(--font-serif), "Fraunces", Georgia, serif',
  playfair: 'var(--font-playfair), "Playfair Display", Georgia, serif',
  grotesk: 'var(--font-grotesk), "Space Grotesk", var(--font-narrow), sans-serif',
  bebas: 'var(--font-bebas, "Bebas Neue"), var(--font-narrow), sans-serif',
  anton: '"Anton", var(--font-bebas), sans-serif',
  teko: '"Teko", var(--font-narrow), sans-serif',
};

export const BODY_STACKS: Record<BodyFace, string> = {
  archivo: 'var(--font-sans), "Archivo", -apple-system, sans-serif',
  inter: 'var(--font-inter), "Inter", -apple-system, sans-serif',
  plex: 'var(--font-plex), "IBM Plex Sans", -apple-system, sans-serif',
  ranade: '"Ranade", var(--font-sans), sans-serif',
  sora: '"Sora", var(--font-inter), sans-serif',
  "public-sans": '"Public Sans", var(--font-inter), sans-serif',
  nunito: '"Nunito", var(--font-inter), sans-serif',
  montserrat: '"Montserrat", var(--font-inter), sans-serif',
  "red-hat": '"Red Hat Display", var(--font-inter), sans-serif',
  firasans: '"Fira Sans", var(--font-inter), sans-serif',
};

export const LABEL_STACKS: Record<LabelFace, string> = {
  narrow: 'var(--font-narrow), "Archivo Narrow", sans-serif',
  azeret: '"Azeret Mono", var(--font-mono), monospace',
  jetbrains: 'var(--font-mono), "JetBrains Mono", monospace',
  teko: '"Teko", var(--font-narrow), sans-serif',
};

export const SUBHEAD_STACKS: Record<Exclude<SubheadFace, "match-display" | "match-body">, string> = {
  sora: BODY_STACKS.sora,
  ranade: BODY_STACKS.ranade,
  grotesk: DISPLAY_STACKS.grotesk,
};

/** Suggested complementary body faces per display pick */
export const SUGGESTED_BODY_FOR_DISPLAY: Partial<Record<DisplayFace, BodyFace>> = {
  array: "ranade",
  tanker: "montserrat",
  neco: "sora",
  nippo: "firasans",
  telma: "nunito",
  boxing: "public-sans",
  kola: "archivo",
  instrument: "archivo",
  playfair: "nunito",
  grotesk: "inter",
  bebas: "montserrat",
  anton: "public-sans",
  teko: "firasans",
};

export function resolveSubheadStack(
  subhead: SubheadFace,
  display: DisplayFace,
  body: BodyFace,
): string {
  if (subhead === "match-display") return DISPLAY_STACKS[display] ?? DISPLAY_STACKS.instrument;
  if (subhead === "match-body") return BODY_STACKS[body] ?? BODY_STACKS.archivo;
  return SUBHEAD_STACKS[subhead] ?? BODY_STACKS.archivo;
}

export const LEGACY_DISPLAY_MAP: Record<string, DisplayFace> = {
  instrument: "instrument",
  playfair: "playfair",
  grotesk: "grotesk",
};

export const LEGACY_BODY_MAP: Record<string, BodyFace> = {
  archivo: "archivo",
  inter: "inter",
  plex: "plex",
};
