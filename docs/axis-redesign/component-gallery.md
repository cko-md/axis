# AXIS component gallery

The authenticated `/design-system` route is the live reference for AXIS's
semantic typography, surfaces, motion, controls, loading treatments, freshness,
status callouts, and modal behavior. It uses production components and the same
theme provider as every operational module.

## Token contracts

| Family | Purpose | Source |
|---|---|---|
| Typography | Fixed display/title/heading/body/label/micro roles and line heights; runtime face aliases resolve from `body` | `src/app/globals.css`, `src/lib/design/systemTokens.ts` |
| Surfaces | Canvas, chrome, panel, raised panel, input, overlay, border, and shadow roles | `src/app/globals.css`, `src/lib/design/systemTokens.ts` |
| Motion | Instant, fast, base, deliberate, ambient, enter, exit, and standard easing roles | `src/app/globals.css`, `src/lib/design/systemTokens.ts` |
| Status | Muted, accent, success, warning, alert, and danger | `src/lib/design/statusTokens.ts` |
| Interaction | Foreground-on-accent and focus-indicator roles with theme/preset contrast tests | `src/app/globals.css`, `src/lib/design/systemTokens.ts` |

Semantic roles alias the established AXIS theme primitives. Dark, Dim, Slate,
Light, accent presets, density, and surface-tone customization therefore remain
the source of rendered values; components do not fork their own palettes.

## Shared component expectations

- `Button`: preserves its command label while loading, disables duplicate input,
  and exposes `aria-busy`.
- `Seg`: requires a descriptive group name and exposes `aria-pressed` selection state.
- `Modal`: has a unique accessible title, closes on Escape/backdrop, traps focus
  across currently enabled controls, and restores focus to its trigger.
- `StatusCallout`: uses `alert` for failures and `status` for non-error state.
- `FreshnessBadge`: exposes the tier and description independently of color.
- `Skeleton`: is decorative and becomes static under reduced motion.

All operational-looking copy and values on this route are explicitly specimens;
the gallery never presents examples as live account, provider, or routine data.

## Theme and accessibility review

The authenticated browser suite exercises the live gallery at 1024, 800, 768,
390, and 320 pixels in Dark, Dim, Slate, and Light. It checks runtime font aliases,
keyboard focus trapping/restoration, dialog Escape behavior, loading busy state,
destructive confirmation, responsive overflow, and reduced motion. Pure token
tests enforce the theme/accent contrast matrix. Semantic durations collapse to
`0.01ms` and ambient/loading effects become static when reduced motion is set.
