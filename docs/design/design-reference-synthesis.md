# AXIS Design Reference Synthesis

> How external references map to AXIS surfaces. AXIS = Dimension foundation + selective borrowings — not a gallery paste.

---

## Sources

| Source | Availability | Role in AXIS |
|--------|--------------|--------------|
| DESIGN (1) — Monopo | Mission brief only (not in repo) | Atmospheric iridescence, editorial restraint |
| DESIGN (3) — Superhuman | Mission brief only | Floating card hierarchy, product polish |
| DESIGN (4) — Dimension | Mission brief only | Frosted workspace shell, dusk canvas |
| Lucide | `lucide-react@^1.23` | Operational icon baseline |
| Aceternity UI | External reference | Cinematic motion inspiration — adapt, don't import |
| Skiper UI | External reference | Pattern comparison set |
| Fontshare | External reference | Typography research — no new fonts Batch 1 |
| `docs/DESIGN_HANDOFF.md` | In repo | Atelier token reference (partially stale) |

---

## Borrowed from DESIGN (1) — Monopo

**Accepted:**
- Liquid iridescence as **atmosphere only** (depth field `.wash`, `.aurora`)
- Radical monochrome discipline on controls
- Patient motion on scene transitions (`dfwash`, `dfdrift` keyframes)
- One expressive chromatic gesture per scene (gold signal channel)
- Full-pill actions for high-level CTAs (`.btn-primary` radius)

**Rejected:**
- Gradients inside routine buttons, badges, dense data cards
- Heavy decorative chrome on every surface
- Iridescence in mail body / financial charts / tables

**AXIS surfaces:** `/` landing, login atmosphere, Command depth field, empty states, presence reveal.

---

## Borrowed from DESIGN (3) — Superhuman

**Accepted:**
- Floating frosted product cards (`html.light .widget-shell`, `.module`)
- Translucent UI-over-atmosphere compositing
- Clear CTA hierarchy in Interface Studio preview card
- Sticky blurred topbar (`.topbar` backdrop-filter)

**Rejected:**
- Warm parchment / maroon-violet brand palette
- Marketing-page density in operational modules

**AXIS surfaces:** Interface Studio previews, Mail reader panels, Briefing cards, Fund summary.

---

## Borrowed from DESIGN (4) — Dimension

**Accepted:**
- Dark-first dusk canvas (`--bg` near-black family)
- Frosted glass panels (`--glass`, `backdrop-filter: var(--blur)`)
- Hairline borders (`--line`, 1px)
- Pill controls for filters (`.seg`, `.swatches`)
- Low colorfulness, high legibility

**Rejected:**
- Gradients as UI fill (kept atmospheric only)
- Heavy drop shadows (light theme uses gentle cool shadows only)

**AXIS surfaces:** App shell, widgets, Control Room, all dark/dim/slate modules.

---

## Borrowed from Lucide

**Accepted:**
- Stroke-based operational icons (1.6 stroke default)
- Semantic nav mapping via `src/lib/icons/nav-icons.ts`
- Shared `Icon` primitive (`src/components/ui/Icon.tsx`)

**Rejected:**
- Replacing brand presence SVGs (Axiom/Codex/Nova characters)
- Filled icons in dense dashboard UI

**Custom exceptions:** Companion character SVGs, AXIS wordmark, provider logos.

---

## Borrowed from Aceternity / Skiper

**Accepted (as patterns to adapt):**
- Aurora / spotlight backgrounds → existing `.depthfield` system
- Card hover spotlight → future `WidgetShell` focus state
- Loader shimmer → existing `.skeleton` patterns

**Rejected:**
- Direct component imports (bundle, SSR, hydration risk)
- Flashy text effects on data-critical surfaces
- Magnetic buttons in workflow tables

See `docs/design/component-inspiration-audit.md`.

---

## Borrowed from Fontshare

**Accepted:** Research only — current `next/font` stack sufficient for Batch 1.

**Rejected:** Arbitrary font URL injection; large payload expansion.

See `docs/design/typography-research.md`.

---

## Final AXIS visual principles

1. **Dark-first command center** — Dimension frosted shell
2. **Silver/chrome light** — cool gallery, not parchment (`html.light`)
3. **Atmospheric iridescence** — tokenized `--axis-*`, scene-level only
4. **Premium surfaces + loading** — token-safe `axis-glass-panel/axis-chrome-panel` and `.axis-loading-sheen` for loading
4. **Lucide operational glyphs** — consistent stroke, semantic mapping
6. **Honest system states** — live/stale/error/lab/disconnected/local badges
7. **Editorial restraint** — typography hierarchy without heavy weights
8. **Reduced motion** — `prefers-reduced-motion` disables aurora animation
9. **AXIS identity** — not Monopo, Superhuman, Dimension, or Aceternity clones

---

## Surface mapping

| Surface | Primary reference | Secondary |
|---------|-------------------|-----------|
| App shell / sidebar | Dimension | Lucide |
| Command / widgets | Dimension | Superhuman cards |
| Landing / login | Monopo atmosphere | Aceternity aurora |
| Interface Studio | Superhuman | Dimension tokens |
| Mail / Notes reader | Dimension legibility | Superhuman polish |
| Presence forms | Monopo reveal | Dimension glass popout |
| Light theme | Monopo discipline | Superhuman floating cards |
