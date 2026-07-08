# Presence Forms Audit

> Consolidates `docs/audits/axis-presence-forms-audit-2026-07-01.md` + Batch 0/1 updates

---

## Taxonomy

| Name | Key | Role | Default |
|------|-----|------|---------|
| Axiom | `monolith` | Strategic advisor + focus tracking | ✅ default form |
| Codex | `deck` | Contextual intel cards | |
| Nova | `nova` | Quick oracle Q&A | |
| Hidden | `presence: hide` | No companion | ✅ default visibility |

---

## Strengths

- Distinct interaction models per form
- Keyboard activation, Escape close, loading states
- Module-scoped `buildContext` — not full data dump
- Reduced-motion on primary SVG animations
- Supabase sync for interface settings (signed-in)

---

## Batch 1 fixes

| Finding | Status |
|---------|--------|
| Nova hardcoded blue hex | ✅ Tokenized `--companion-nova-core/glow` |
| Gold ring on Nova orbital | ✅ `--companion-axiom-ring` |

---

## Open findings

### P1 — Popout dialog semantics
- No `role="dialog"`, focus trap incomplete, no focus restore
- **Batch:** 2 (shared `PopoutShell` a11y)

### P1 — Sentry on companion failures
- Local fallback only; no client capture with safe metadata
- **Batch:** 8

### P1 — Axiom focus localStorage-only
- `axiom-focus` key separate from Interface Studio
- **Fix:** Label "Local only" or migrate to `user_preferences`

### P2 — Privacy disclosure
- No inline "sent to AI" badge near input
- **Batch:** 2

### P2 — Mobile safe area
- Fixed 280–360px popouts; no `env(safe-area-inset-bottom)`
- **Batch:** 2

### P2 — Reduced motion incomplete
- Hover transforms, shimmer, typing bounce still animate
- **Batch:** 2

### P3 — Dismiss/restore aria-labels
- Title-only tooltips
- **Batch:** 2

---

## Simplification assessment

**Keep three forms** — each serves a distinct workflow:
- Axiom: sustained focus + strategy
- Codex: passive contextual cards
- Nova: ephemeral Q&A

Do not add a fourth form without retiring one.

---

## Theme QA (deferred Batch 9)

Validate Axiom/Codex/Nova across dark, dim, slate, light × gold, marine, clay, chrome accents.
