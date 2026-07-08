# Interface Studio Roadmap

> Personalization surface at `InterfaceStudioDrawer.tsx` + `ThemeProvider.tsx`

---

## Current capabilities ✅

| Control | Persistence | Sync |
|---------|---------------|------|
| Theme mode (dark/dim/slate/light) | localStorage + Supabase | ✅ |
| Accent preset (6) | Settings JSON | ✅ |
| Surface tone (deep/mid/lifted) | Runtime CSS + dataset | ✅ |
| Corner radius 0–16px | Runtime CSS | ✅ |
| Display font (3) | `--serif` on body | ✅ |
| Body font (3) | `--sans` on body | ✅ |
| Density (cozy/default/compact) | `data-density` on body | ✅ |
| Companion form (Axiom/Codex/Nova) | dataset + settings | ✅ |
| Presence show/hide | dataset + settings | ✅ |
| Location services | settings | ✅ (Console geo) |
| Notification prefs | settings | ⚠️ Stored only — labeled Batch 1 |
| Reset to defaults | — | ✅ |

---

## Gaps

### P1 — Notification delivery service
- **Current:** Toggles persist; no consumer
- **Fix:** Background worker or browser Notification API + permission flow
- **Batch:** 8

### P2 — Preview affordances
- **Current:** Static preview card in drawer
- **Fix:** Live mini shell showing active widget + mail row + nav snippet
- **Batch:** 2

### P2 — Sync status clarity
- **Current:** Local / Syncing / Synced / Error badges
- **Fix:** Retry action on error; last-synced timestamp

### P3 — Custom CSS editor
- **DESIGN_HANDOFF claims it exists** — it does not
- **Decision:** Reject unless power-user demand; security risk

### P3 — Sidebar mode persistence
- **DESIGN_HANDOFF claims `axis-sidebar` localStorage** — AppShell uses in-memory state
- **Fix:** Either persist to settings or update docs

---

## Recommended additions (curated)

1. **Silver/chrome light label** in theme picker — "Gallery" subtitle
2. **Font pairing presets** — one-click Editorial / Technical / Default
3. **Motion preference** — respect system + optional "cinematic" override
4. **Presence privacy badge** — compact "Prompts sent to AI" in companion popout

---

## Not planned

- Arbitrary user font URLs
- Per-module theme overrides (complexity)
- Third-party theme import

---

## Batch 1 changes

- Notification section honest copy: preferences saved, delivery not wired
