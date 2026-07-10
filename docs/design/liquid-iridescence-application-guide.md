# Liquid Iridescence Application Guide

> When and how to use atmospheric iridescence in AXIS. **Never** use for functional status or dense data.

---

## Token inventory (Batch 1)

Defined in `src/app/globals.css` `:root`:

```css
--axis-iridescent-sage: rgb(160, 224, 171);
--axis-iridescent-amber: rgb(255, 172, 46);
--axis-iridescent-oxblood: rgb(165, 45, 37);
--axis-dusk-violet: rgb(107, 98, 242);
--axis-cobalt: rgb(48, 92, 220);
--axis-chrome-white: #f8fafc;
--axis-chrome-silver: #d7dce5;
--axis-chrome-graphite: #16181d;
--axis-glass-border: rgba(255, 255, 255, 0.16);
--axis-glass-fill: rgba(255, 255, 255, 0.07);
--axis-liquid-ease: cubic-bezier(0.19, 1, 0.22, 1);

/* liquid atmosphere tuning */
--axis-liquid-pearl: rgba(248, 250, 252, 0.72);
--axis-liquid-veil: rgba(255, 255, 255, 0.08);
--axis-liquid-glint: rgba(255, 255, 255, 0.22);
--axis-liquid-shadow: rgba(0, 0, 0, 0.42);

/* motion tokens */
--axis-motion-fast: 140ms;
--axis-motion-base: 220ms;
--axis-motion-slow: 700ms;
--axis-motion-cinematic: 1200ms;

--axis-ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
--axis-ease-liquid: cubic-bezier(0.19, 1, 0.22, 1);

/* loading sheen */
--axis-loading-sheen-duration: 1400ms;
--axis-loading-sheen-angle: 110deg;
```

Existing depth field uses gold/marine/clay rgba washes — future refactors should reference `--axis-*` tokens.

---

## Approved surfaces

| Surface | Implementation | Motion |
|---------|----------------|--------|
| Home / landing hero | `.depthfield .wash`, `.aurora` | `dfwash` 38s — disabled in `html.light` static washes |
| Login / onboarding | Depth field behind card | Reduced motion: static gradient |
| Command background | App shell depth field | Stars 18:00–06:00 |
| Interface Studio preview | Preview card glass | None on controls |
| Presence form aura | Nova gradients via `--companion-nova-*` | SVG ring animation — reduced-motion partial |
| Empty states | Subtle radial wash behind illustration | Optional |
| Loading skeletons | No iridescence — use `AxisLoadingSheen` / `axis-loading-sheen` neutral shimmer | — |

---

## Prohibited surfaces

- Data tables, mail body, note editor body
- Financial charts (`--chart-*` only)
- Provider health text, error messages, status badges
- Destructive action buttons
- Every card / every button

---

## Implementation rules

1. **Tokenize** — no raw hex in new atmospheric code
2. **`prefers-reduced-motion`** — disable depthfield drift/wash and shimmer animations (implemented in `globals.css`)
3. **`prefers-reduced-transparency`** — fall back to less-blurred frosted fills where implemented (e.g. glass panels)
4. **Contrast** — atmospheric layers are `pointer-events: none`, z-index 0
5. **Performance** — no expensive filters on scroll containers; depth field is `position: fixed`
6. **Never imply provider status** with color animation

---

## Light theme (silver/chrome)

- `html.light .depthfield` uses cool skylight washes, brushed-metal glints
- Animations disabled — static spectral edge only
- Cards: frosted white `--glass` + `--panel-shadow`
- Iridescence **more restrained** than dark — chromatic silver, not warm gold wash

---

## Companion-specific

```css
--companion-nova-core: var(--marine);
--companion-nova-glow: var(--marine-2);
--companion-axiom-ring: var(--gold);
```

Nova SVG references these — respects accent preset changes.

---

## QA checklist

- [ ] Dark: depth field visible, not overpowering mail reader
- [ ] Light: panels read as frosted white on silver ground
- [ ] Reduced motion: no aurora drift
- [ ] Chrome accent: companion colors remain legible
- [ ] No gradient inside `.btn-primary` fill (uses `--gradient-btn` — acceptable for CTA only)
