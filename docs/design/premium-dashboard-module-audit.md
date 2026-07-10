# AXIS Premium Dashboard Module Audit
> Checklist to keep modules premium, legible, theme-safe, and production-grade.
---

## Audit goals

1. Surface quality:
   - frosted precision panels
   - hairline borders
   - consistent radii + padding rhythm
2. Information hierarchy:
   - clear metadata rows
   - readable headings
   - no “dead” tiles (everything opens or is explicitly disabled/coming-soon)
3. State honesty:
   - loading/empty/error/offline/disconnected are distinct and actionable
4. Iridescence discipline:
   - atmosphere only (never status semantics, provider health, error text, or chart plot areas)
5. Accessibility:
   - focus-visible
   - contrast-safe colors
   - reduced-motion preserved

## Route-level premium checks

### `/command`
- Widget shells look consistent and “floated” without heavy shadows (use frosted Tier 1/2).
- Active module spotlight is atmospheric only (Tier 2 behavior).
- Command palette and drawers remain crisp under all themes.

### `/mail`
- Inbox rows open into readable detail.
- Mail body and note bodies remain clean: no liquid gradients or iridescent fills.
- Empty/loading states use neutral shimmer (AxisLoadingSheen), not liquid effects.

### `/notes`
- List cards use frosted shell tier.
- Editor body remains clean + legible (no iridescence behind writing surface).

### `/fund`
- Tables and charts remain chart-safe:
  - no liquid effects inside chart plot areas
  - rely on hairline grids and semantic surfaces

## Component-level checklist

- Every card/module has:
  - hover/focus style
  - visible selected/active state (semantic-safe)
  - clear empty/loading/error UI
- Motion:
  - operational: fast + precise
  - atmospheric: cinematic only where route/scene makes sense
  - `prefers-reduced-motion` disables shimmer/aurora.

