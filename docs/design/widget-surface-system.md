# AXIS Widget Surface System
> Token-safe surface language for cards/widgets/modules across density + themes.
---

## Widget shell tiers

### Tier 1 — Core operational widgets
- Very restrained surface treatment.
- Maximum legibility.
- Mostly frosted graphite / chrome panel fill.
- Minimal iridescence (prefer none).
- Best for: provider health, lists, tables, status lists, mail/prereader rows, task queues.

### Tier 2 — Summary + command widgets
- More precise premium surface treatment (still hairline borders).
- Subtle reflections allowed.
- Active-state atmospheric glow allowed behind the shell.
- Best for: command summaries, daily briefings, active modules, high-value widgets.

### Tier 3 — Hero / onboarding / presence / empty states
- Most atmospheric.
- Liquid iridescence allowed behind the shell (scene-level).
- Cinematic motion allowed (always reduced-motion aware).
- Best for: `/` landing moments, login/onboarding moments, presence reveal, premium empty states, route headers.

## Allowed surface treatments

### Glass / frosted
- Uses `--glass` / `--glass-2` + `backdrop-filter: var(--blur)`.
- Borders use 1px hairline `--line` / `--line-strong`.
- Use for: widget shells, module containers, modal bodies, drawer panels.

### Chrome / gallery mode (light theme)
- Uses the same primitives but relies on `html.light` token polarity:
  - frosted-white glass panels (`--glass` / `--glass-2`)
  - cool chrome ground (`--bg`)
- Use for: the “silver/chrome gallery mode” experience.

### Reflective cards
- For premium “content-first” composition: subtle inner highlight overlay + panel depth.
- Token: `--panel-shadow` (never generic shadows).

## Card radius rules

- Base: `border-radius: var(--rl)` for panels/cards in dense UI.
- Cards and widget shells should not use intermediate radii ad-hoc; stick to `--rl` and the existing runtime corner radius system.

## Border rules

- Default: `1px solid var(--line)` (hairline).
- Hover/active: `1px solid var(--line-strong)` or tokenized accent mix.
- Error/failed provider states must be semantic (use `--status-error`, not iridescence).

## Glass / chrome rules

- Glass fill: `background: var(--glass)` or `var(--glass-2)`.
- Glass border: `border-color: var(--axis-glass-border)` (tokenized).
- Reduced transparency:
  - Prefer `@media (prefers-reduced-transparency: reduce)` to drop `backdrop-filter`.
  - Fall back to a more opaque fill (`--glass-2`).

## Active / focus / hover states

- Hover: increase border contrast slightly; keep fill subtle.
- Focus-visible:
  - Use `outline: 2px solid color-mix(in srgb, var(--gold) 58%, transparent)`.
  - Never animate outline into semantic status colors.
- Selected:
  - Optional: halo behind shell for Tier 2 (route-safe only).

## Empty / loading / error states

### Empty states
- Use a dedicated empty panel surface (Tier 3 if it’s a premium module).
- Iridescence:
  - Allowed as a subtle background wash only.
  - Never inside data table bodies or editor bodies.

### Loading states
- Loading surfaces must use `AxisLoadingSheen` / `axis-loading-sheen`.
- Iridescence:
  - Prohibited; use neutral shimmer only.

### Error states
- Error surfaces must be semantic:
  - `--status-error` for accents
  - no iridescent animated overlays
- Always include visible recovery actions (retry / reconnect) where relevant.

## Route-specific widget examples (guidance)

- `/command`:
  - Tier 1 grid of operational widgets
  - Tier 2 command summary panels with subtle active aura
  - route-level atmosphere comes from `depthfield`, not card backgrounds

- `/mail`:
  - Inbox rows: Tier 1 cards (no iridescent fills)
  - Reader surface: neutral frosted precision, keep body legible
  - Empty/loading: neutral shimmer + premium empty panel (Tier 3) if there is an editorial moment

- `/notes`:
  - Editor body: clean and legible (no iridescence)
  - list cards: Tier 1 glass shells

- `/fund`:
  - metric tiles: Tier 1 with tabular-number readability
  - charts: keep plot areas clean (no liquid effects inside chart surfaces)

