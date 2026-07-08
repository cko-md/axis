# AXIS Adversarial Rescue Audit

> **Date:** 2026-07-08  
> **Branch:** `cursor/adversarial-rescue-audit-c4ca`  
> **Base:** `main` @ `35cf59f`  
> **Method:** Multi-agent static inspection + baseline checks (`tsc`, `lint`, `vitest`) + design-reference synthesis  
> **Scope:** Full platform — 35 routes, 114 API handlers, 415 TS/TSX files, 61 migrations, 53 test files (341 tests)

---

## Executive summary

AXIS is a **mature integrations-heavy personal OS**, not a prototype collection. The platform audit (`docs/audits/axis-platform-audit.md`) understates current reality: most modules are Supabase-backed with realtime hooks, mail uses a unified adapter layer, and CI runs 341 unit tests.

The rescue mission targets **trust gaps** — silent failures, localStorage degradation, integration dead-ends, design-system drift, and production hygiene — not greenfield scaffolding.

### Platform inventory

| Dimension | Count | Notes |
|-----------|-------|-------|
| Page routes | 35 | Includes 10 Fund subroutes |
| API route handlers | 114 | Mail, calendar, fund, AI, cron, webhooks |
| Module components | 20+ | Under `src/components/*` |
| Supabase migrations | 61 | **Ordering inconsistent** (A4) |
| Unit tests | 341 / 53 files | All passing at audit start |
| E2E | Playwright public + auth projects | Not run in Batch 0 |
| Themes | dark, dim, slate, light | Light = silver/chrome gallery |
| Accent presets | gold, marine, clay, bone, sage, chrome | Via Interface Studio |
| Presence forms | Axiom, Codex, Nova | Default hidden |
| Tembo role | **Unspecified** | No Tembo config found in repo |

### Baseline checks (Batch 0)

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Pass |
| `npm run lint` | ✅ Pass (1 pre-existing warning in `text-effect.tsx`) |
| `npm run test` | ✅ 341/341 pass |
| `npm run build` | Deferred to Batch 1 post-patch |
| Vercel preview | Not accessed — manual steps in validation log |
| Sentry | Not accessed — manual query steps documented |
| Supabase remote | Not accessed — local stack per AGENTS.md |

### Design reference status

| Reference | In workspace? | Status |
|-----------|---------------|--------|
| DESIGN (1).md — Monopo | ❌ Not in repo | Synthesis from mission brief |
| DESIGN (3).md — Superhuman | ❌ Not in repo | Synthesis from mission brief |
| DESIGN (4).md — Dimension | ❌ Not in repo | Synthesis from mission brief |
| `docs/DESIGN_HANDOFF.md` | ✅ | Partially stale |
| Lucide / Aceternity / Skiper / Fontshare | External | Reviewed via mission brief + codebase |

### Top systemic risks

1. **Silent localStorage fallbacks** for signed-in users (Vitality trio, Literature prefs) — P0/P1
2. **Composio execute bridge** — arbitrary tool proxy without allowlist — P0
3. **Multi-account mail identity** — placeholder labels, no `accountId` in UI — P0
4. **Notification settings UI-only** — persisted but no delivery — P1 (now labeled)
5. **Migration ordering** — duplicate prefixes, unnumbered files — P1
6. **Icon fragmentation** — lucide installed, inline SVGs everywhere — P1 (Batch 1 started)
7. **Monolithic globals.css** (~5k LOC) + hybrid Tailwind — P2 maintainability

---

## Module completeness matrix

See `docs/design/cross-module-workflow-validation.md` for workflow chains.

| Module | Workflow | Severity gap |
|--------|----------|--------------|
| Command/Console | Mostly complete | Widget drill-in shallow (P2) |
| Dispatch | Complete | Reference implementation |
| Mail | Mostly complete | Composio multi-account, pagination (P1) |
| Notes | Complete | — |
| Schedule | Complete | Vitality push stub (P3) |
| Agenda | Mostly complete | Routine persist swallowed catch (P2) |
| Fund | Complete | Provider-degraded states OK |
| Vitality | Partial | localStorage fallbacks, health OAuth dead-end (P0/P1) |
| Literature | Mostly complete | Prefs localStorage degrade (P1) |
| Supper Club | Static | localStorage only (P0) |
| Debrief | Partial | Demo data during load (P1) |
| Control Room | Complete | — |
| Labs (Atelier, Vault, Library) | Lab-labelled in nav | Honest status badges present |

---

## Architecture observations

- **Mail adapters:** Unified `MailAdapter` + `Result<T>` — production-ready pattern; extend to calendar/contacts.
- **AI:** Typed action registry exists; many UI call sites bypass `callAiAction` — drift risk.
- **Widgets:** Registry + cache tests exist; Console still fans out live provider calls on first paint.
- **RLS:** All tables have owner-scoped policies per platform audit; migration apply order is the risk.
- **Sentry:** Scrubbing configured; AI route intentionally avoids capture for privacy.

---

## Rescue batch plan

| Batch | Focus | Status |
|-------|-------|--------|
| 0 | Inventory + finding register + design docs | ✅ This document |
| 1 | Theme tokens, Icon primitive, Lucide nav, presence tokenization | 🔄 In progress |
| 2 | Shared UX primitives, widget status foundation | Pending |
| 3 | Console/widget data architecture | Pending |
| 4 | Daily production modules (Mail parity) | Pending |
| 5–9 | Beta/lab modules, hardening, visual QA | Pending |

---

## Related documents

- `docs/audits/adversarial-rescue-finding-register.md` — all findings with IDs
- `docs/audits/adversarial-rescue-patch-plan.md` — patch sequencing
- `docs/audits/adversarial-rescue-validation-log.md` — check results per batch
- `docs/design/*` — design synthesis, iconography, typography, QA matrices
