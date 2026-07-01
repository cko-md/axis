# AXIS Rendering And Interface Audit - 2026-07-01

> Issue: DOC-5 - Design/rendering audit addendum  
> Scope: static audit of theme, rendering, Interface Studio, typography, density, presence forms, app shell atmosphere, mobile behavior, and reduced motion.  
> Sources inspected: `src/app/layout.tsx`, `src/app/globals.css`, `src/components/layout/AppShell.tsx`, `src/components/layout/Mascot.tsx`, `src/components/theme/ThemeProvider.tsx`, `src/components/theme/InterfaceStudioDrawer.tsx`, `src/lib/theme/interface-settings.ts`, and nav/status rendering.

## Executive Summary

AXIS already has a strong visual point of view: architectural dashboard chrome, restrained dark surfaces, molten gold signal accents, slate/dim alternates, animated depthfield atmosphere, curated type choices, and optional presence forms. The implementation is not a prototype-level theme; it is a real design system foundation.

The biggest risk is that personalization is visually ambitious but not yet operationally trustworthy. Theme and interface settings are localStorage-only with no visible persistence state, light mode is still warm parchment rather than the requested silver/chrome gallery theme, Interface Studio lacks preview/focus mechanics, and presence AI/local focus state needs explicit privacy and fallback treatment. Phase 1 should refine this foundation before module polish.

## Findings

| ID | Priority | Surface | Finding | Evidence | Follow-up issue |
|---|---|---|---|---|---|
| R1 | P0 | Light theme | Current light mode is warm parchment/museum gallery, not the requested whiter silver/chrome gallery. | `html.light` tokens use `#f4f0e8`, `#ede8de`, warm amber depthfield comments, and parchment/gold language. | THEME-1 |
| R2 | P0 | Persistence | Theme and Interface Studio settings are localStorage-only with no visible saved/local-only/error state. | `ThemeProvider` reads/writes `axis-theme` and `axis-interface-settings`; storage failures are swallowed. | THEME-6 |
| R3 | P1 | Hydration/flash | Theme is applied after mount, so non-dark stored themes can first paint as default dark despite `suppressHydrationWarning`. | `ThemeProvider` initializes `theme` as `"dark"` and applies stored value in `useEffect`. | THEME-6 / RENDER-1 |
| R4 | P1 | Interface Studio | Drawer has real controls but no preview cards, focus trap, escape handling, or explicit keyboard return path. | `InterfaceStudioDrawer` returns a dialog and backdrop, but no focus management or preview surface beyond live app mutation. | THEME-3 |
| R5 | P1 | Typography | Font choices are curated and finite, but all optional fonts are loaded globally whether selected or not. | `layout.tsx` loads Playfair, Space Grotesk, Inter, IBM Plex Sans, and Bebas Neue in addition to defaults. | THEME-4 |
| R6 | P1 | Density/radius | Density adjusts broad selectors, but fixed-format module controls may still overflow or feel uneven. | `body[data-density]` changes base font, `.card`, `.view-pad`, `.grid`, and spacing variables only. | THEME-5 |
| R7 | P1 | Presence privacy | Axiom stores focus in localStorage and sends module context/focus to `/api/ai`; UI does not yet make privacy/provider fallback obvious. | `Mascot.tsx` uses `localStorage.getItem("axiom-focus")` and posts companion prompts to `/api/ai`. | PRESENCE-3 |
| R8 | P1 | Presence accessibility | Presence forms are visually distinctive but need audit for focus order, popout mobile fit, close controls, labels, and reduced-motion completeness. | Mascot popouts are absolutely positioned near bottom-right; reduced-motion blocks cover some but not all transform transitions. | PRESENCE-1 / PRESENCE-2 |
| R9 | P1 | App atmosphere | Depthfield, aurora, grain, blur, stars, and fixed overlays are sophisticated but performance-sensitive on mobile/low-power devices. | `AppShell` always renders depthfield/grain; CSS uses large blurred radial layers and animated transforms. | RENDER-1 |
| R10 | P2 | Reduced motion | Multiple reduced-motion blocks exist, but no single policy guarantees all transitions/animations are covered. | `globals.css` has targeted `prefers-reduced-motion` blocks for widgets, presence, vault, and atmosphere. | WID-4 / RENDER-1 |
| R11 | P2 | Status vocabulary | AppShell surfaces beta/lab banners from nav, but local-only, disconnected, stale, permission-denied, and provider-unconfigured are not global shell-level states. | `AppShell` renders only beta/lab status banners; module-level handling is inconsistent by module. | UX-1 |
| R12 | P2 | Accent presets | Implemented accent presets exceed the requested QA matrix. Bone and sage exist but are not in the pasted phase matrix. | `AccentPreset` includes `gold`, `marine`, `clay`, `bone`, `sage`, `chrome`. | THEME-2 |

## Current Strengths To Preserve

- The AXIS visual language is coherent: near-black default, dim amber, slate blue, warm light, gold signal, marine data, clay warning.
- Type is deliberately curated: Archivo, Archivo Narrow, Fraunces, JetBrains Mono, plus finite Interface Studio alternatives.
- Interface Studio applies settings live through CSS variables rather than duplicating theme branches throughout components.
- AppShell already provides status banners for beta/lab modules using `src/lib/store/nav.ts`.
- Reduced-motion awareness exists and should be consolidated rather than introduced from scratch.
- Presence forms are differentiated enough to be memorable: Axiom, Codex, and Nova have distinct silhouettes and behavior.

## Phase 1 Recommendations

1. Start with THEME-1 and convert light mode from warm parchment into a silver/chrome gallery theme. Avoid simply desaturating the current palette; build a colder material system with crisp white/silver surfaces, graphite text, subtle chromatic accents, and visible but restrained borders.
2. Follow immediately with THEME-6 so personalization persistence is honest. Either sync signed-in settings to Supabase/user preferences or label them as local-only; do not imply account-wide personalization while using localStorage only.
3. Upgrade Interface Studio before adding more controls. It needs previews, saved/local state, keyboard/focus handling, reset clarity, and mobile behavior.
4. Treat presence as a privacy surface, not just visual flair. Show provider-unconfigured/offline states and avoid sending private module content or note/email bodies to AI.
5. Create a single reduced-motion policy that covers shell atmosphere, drawers, widgets, presence forms, and media-room effects.

## Cross-Theme QA Matrix

Use this representative matrix for Phase 1 and later UI-facing issues. Full matrix can be sampled when the issue is narrow; document deferred combinations.

| Axis | Required values |
|---|---|
| Theme | dark, dim, slate, silver/chrome light |
| Accent | gold, marine, clay, chrome |
| Density | compact, default, cozy |
| Font pairing | default, editorial/display-heavy, grotesk/body-modern |
| Presence | hidden, Axiom, Codex, Nova |
| Motion | normal, prefers-reduced-motion |

High-risk route subset:

```text
/command
/mail
/notes
/fund
/control-room
/literature
/vitality
```

## Manual Validation Checklist

- Open `/command`, switch through dark/dim/slate/light, and confirm text, borders, controls, widgets, and shell chrome remain legible.
- Open Interface Studio on desktop and mobile widths; verify focus, close behavior, scroll containment, reset confirmation, and live setting changes.
- Toggle density and radius; verify cards, toolbar controls, nav, drawers, and fixed-format widgets do not shift or overflow.
- Switch font pairings; verify headings, compact controls, message readers, notes editor, and tables do not clip.
- Toggle presence hidden/Axiom/Codex/Nova; verify popouts fit on mobile and reduced-motion disables decorative loops.
- Enable browser reduced motion and repeat `/command`, `/mail`, `/listening-vault`, and Interface Studio checks.
- Confirm local-only personalization is either clearly labeled or intentionally deferred to THEME-6.

## Production Gate Notes

No runtime changes were made by this audit. Before merging Phase 1 runtime work, require:

- Vercel preview screenshots or recordings for the high-risk route subset.
- Browser validation for reduced motion and mobile widths.
- Sentry review for new client errors after preview interaction.
- Supabase/Tembo statement for any preference persistence changes.
