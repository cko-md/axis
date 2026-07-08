# AXIS Font Pairing System
> Curated font roles for a premium editorial + dashboard hybrid.
---

## Allowed font presets

AXIS uses curated `next/font/google` families loaded in `src/app/layout.tsx`.

Interface Studio switches *roles* via CSS variables set in `src/lib/theme/interface-settings.ts` (`applyInterfaceSettings()`).

Presets (curated, not user-provided URLs):
- **Atelier (default)**: Display `Fraunces` / UI `Archivo` / Mono `JetBrains Mono`
- **Editorial**: Display `Playfair Display` / UI `Inter` / Mono `JetBrains Mono`
- **Technical**: Display `Space Grotesk` / UI `IBM Plex Sans` / Mono `JetBrains Mono`

Also loaded for optional display faces:
- `Playfair_Display`, `Space_Grotesk`, plus `Bebas Neue` for wordmark contexts.

## Display / UI / mono roles

- Display face (`--serif`):
  - Used for editorial/module headings where AXIS wants “expensive calm”.
  - Default maps to `Fraunces`.
- UI face (`--sans`):
  - Used for the majority of dense dashboard UI.
  - Default maps to `Archivo` with Interface Studio override.
- Mono face (`--mono`):
  - Used for technical metadata, IDs, timestamps, and keyboard-ish labeling.

## Type scale

Current base sizing comes from `globals.css` typography usage plus Tailwind defaults.
Dense surfaces should remain readable with:
- body UI: ~13–16px
- metadata labels: ~9–12px
- mono/meta: smaller + tabular numerals

## Weight rules

- Prefer lighter editorial weights; avoid heavy weights in dense modules.
- Mono metadata uses consistent 400/500 weights where needed.
- Display headings:
  - Interact with weight restraint in the “editorial” feel (avoid 700+ defaults).

## Tracking rules

- Dense UI labels:
  - small positive tracking (micro-label spacing) without over-widening.
- Display typography:
  - tighter tracking than body (handled via font choice and existing styles).

## Tabular numeral usage

- `body { font-variant-numeric: tabular-nums; }` already exists in `globals.css`.
- Financial/provider dashboards should rely on tabular numerals for stability.

## Interface Studio preview behavior

Interface Studio must preview:
- how the selected Display/UI/Mono faces render in:
  - a widget shell
  - a module header
  - a mono metadata row
  - a short “numbers” example (tabular stability)

Preview must be token-driven and must not switch to arbitrary font URLs.

