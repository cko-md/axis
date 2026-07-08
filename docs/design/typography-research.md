# Typography Research

> Fontshare personalities reviewed against current AXIS stack. **No new fonts added Batch 1.**

---

## Current font inventory

Loaded via `next/font/google` in `src/app/layout.tsx`:

| Role | Default | Studio alternates |
|------|---------|-------------------|
| Display | Fraunces (`--font-serif`) | Playfair Display, Space Grotesk |
| Body | Archivo (`--font-sans`) | Inter, IBM Plex Sans |
| Narrow / UI chrome | Archivo Narrow | — |
| Wordmark | Bebas Neue | — |
| Mono | JetBrains Mono | — |

CSS tokens on `body`: `--disp`, `--narrow`, `--serif`, `--sans`, `--mono`

Interface Studio applies `--serif`/`--sans` via `applyInterfaceSettings()`.

---

## Fontshare candidates reviewed (personalities filter)

| Personality | Example families (Fontshare) | Assessment |
|-------------|------------------------------|------------|
| Serious | Satoshi, General Sans | Archivo/Inter already serious — skip |
| Luxurious | Gambetta, Sentient | Playfair covers editorial luxury |
| Dramatic | Clash Display, Tanker | Too loud for dense dashboard — reject for body |
| Elegant | Synonym, Zodiak | Fraunces sufficient for display |
| Modern | Satoshi, Switzer | Space Grotesk covers modern grotesk |
| Abstract | Array, Khand | Reject for product UI |
| Futuristic | Excon, Chubbo | Optional hero-only — defer |
| Dirty | — | Not aligned with AXIS identity |

---

## Licensing notes

- All current fonts: Google Fonts / OFL — commercial use OK
- Fontshare fonts: ITF Free Font License — would need per-font verification before add
- **Rule:** No arbitrary user-supplied font URLs

---

## Payload notes

Current `next/font` load: ~6 families with subset latin — acceptable for personalization product.

Adding >2 display families would measurably impact LCP — keep finite palette.

---

## Display / body pairings

| Preset | Display | Body | Best for |
|--------|---------|------|----------|
| Atelier (default) | Fraunces | Archivo | Command, Mail, Notes |
| Editorial | Playfair | Inter | Briefing, Literature |
| Technical | Space Grotesk | IBM Plex Sans | Fund, Control Room |

---

## Dense dashboard legibility test

| Module | 13px body | Tabular nums | Result |
|--------|-----------|--------------|--------|
| Mail reader | ✅ | n/a | Pass |
| Fund tables | ✅ | ✅ `tabular-nums` on body | Pass |
| Notes editor | ✅ | n/a | Pass |
| Console widgets | ✅ | ✅ | Pass |

**Conclusion:** Current stack meets legibility bar. Fontshare adds marginal identity gain at payload cost.

---

## Interface Studio recommendation

1. Keep 3×3 display/body matrix — do not expand until paired preview cards exist
2. Add one-click presets: "Atelier" / "Editorial" / "Technical"
3. Show payload hint: "3 display + 3 body faces loaded"
4. Reject custom URL input permanently

---

## Final accepted / rejected

**Accepted (in production):** Fraunces, Archivo, Archivo Narrow, Bebas Neue, JetBrains Mono, Playfair, Space Grotesk, Inter, IBM Plex Sans

**Rejected Batch 1:** Fontshare imports, user URLs, dramatic display in product modules

**Deferred:** Futuristic display for landing hero only (e.g. single weight of Excon) — evaluate Batch 9
