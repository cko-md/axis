# Component Inspiration Audit — Aceternity & Skiper

> Patterns reviewed for AXIS-native adaptation. **No vendor components imported.**

---

## Aceternity patterns reviewed

| Pattern | Verdict | AXIS equivalent |
|---------|---------|-----------------|
| Aurora background | ✅ Accepted | `.depthfield .aurora` (existing) |
| Spotlight | 🔄 Consider | WidgetShell hover — Batch 2 |
| Glowing effects | ❌ Rejected for dense UI | `--glow` token only on nav active |
| Text generate/reveal | ❌ Rejected | Data surfaces need static text |
| Floating dock | ❌ Rejected | Sidebar + command palette sufficient |
| Animated modal | 🔄 Consider | `Modal.tsx` — add motion optional |
| Card hover spotlight | 🔄 Consider | Adapt to `.card:focus-within` |
| Loader | ✅ Accepted | `Skeleton.tsx` |
| Hero parallax | ❌ Rejected | Performance + a11y |

---

## Skiper patterns reviewed

| Pattern | Verdict | Notes |
|---------|---------|-------|
| Section reveal on scroll | ❌ | Dashboard is not marketing scroll |
| Card stack | 🔄 | Pipeline board — evaluate |
| Magnetic button | ❌ | Workflow noise |
| Gradient borders | ❌ | Use `--line` hairlines |

---

## Dependency impact

| If imported | Risk |
|-------------|------|
| Aceternity copy-paste | framer-motion weight, hydration, Tailwind v4 compat |
| Skiper components | Duplicate primitives, license review |

**Decision:** Zero new UI dependencies Batch 1. `motion` already present for `TextEffect`.

---

## SSR / hydration

- Atmospheric layers: CSS-only — SSR safe ✅
- `TextEffect` (`motion-primitives`): client component — isolate to landing only
- Avoid random-id hydration mismatch in animated components

---

## Accessibility

- All motion behind `prefers-reduced-motion`
- No essential information in animation alone
- Focus management in modals > decorative motion

---

## Bundle / performance

- `lucide-react`: tree-shake per icon import ✅
- `@formkit/auto-animate`: list transitions only
- `motion`: audit usage — keep off critical path

---

## AXIS primitives to build (not import)

1. `Icon` — ✅ Batch 1
2. `AtmosphericPanel` — wrapper for hero/empty states using `--axis-*` tokens
3. `GlassCard` — extends `Card.tsx` with `--glass` + hairline
4. `FocusSpotlight` — optional widget hover (CSS only)

---

## Rejected patterns log

- Gradient-filled buttons in tables
- Neon glow on status badges
- 3D card tilt on mail rows
- Shader backgrounds on `/command`
