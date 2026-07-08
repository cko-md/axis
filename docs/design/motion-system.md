# AXIS Motion System
> Two-speed motion language: atmospheric (cinematic) vs operational (precise). Always reduced-motion aware.
---

## Atmospheric vs operational motion

### Atmospheric motion
- Slow, cinematic, liquid.
- Used for: route transitions, hero/empty-state reveals, presence-form reveals, background aura drift.
- Target duration range: ~700ms–1250ms.
- Easing: `var(--axis-ease-liquid)` (cubic-bezier(0.19, 1, 0.22, 1)).

### Operational motion
- Fast, precise, responsive.
- Used for: buttons, filters, drawers, tabs, widget hover/focus, list expand/collapse.
- Target duration range: ~120ms–240ms.
- Easing: `var(--axis-ease-standard)` or standard transition ease-out.

## Motion tokens

Defined in `src/app/globals.css`:
- `--axis-motion-fast`
- `--axis-motion-base`
- `--axis-motion-slow`
- `--axis-motion-cinematic`
- `--axis-ease-standard`
- `--axis-ease-liquid`

Loading sheen uses:
- `--axis-loading-sheen-duration`
- `--axis-loading-sheen-angle`

## Reduced-motion behavior

- `prefers-reduced-motion: reduce`:
  - Disable depth field animations (`.depthfield .wash/.aurora/.aurora2`).
  - Disable shimmer animations (`.axis-loading-sheen::after`).
  - Preserve state clarity (no “blank” animation-only transitions).

## Route transition rules

- Route entrances must feel like an atmosphere shift:
  - Prefer opacity/transform.
  - Avoid expensive reflow-based movement for dense modules.
- Route veil examples:
  - A fade + subtle panel reveal.
  - Motion should stop when reduced-motion is enabled.

## Loading shimmer rules

- Use neutral sheen only:
  - Tokenized class: `.axis-loading-sheen` / component `AxisLoadingSheen`.
- Do not use iridescence in loading skeletons.

## Hover/focus behavior

- Hover/focus must be crisp, never decorative:
  - Increase border contrast, adjust fill slightly.
  - Focus-visible outline uses semantic-safe accent mix.

## Performance guardrails

- Background atmosphere uses `position: fixed` layers (not scroll-bound).
- Avoid backdrop-filter + blur on large containers in dense routes unless already present.
- Prefer tokenized transitions with small surface-area.

