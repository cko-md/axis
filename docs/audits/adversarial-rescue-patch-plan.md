# AXIS Adversarial Rescue — Patch Plan

> Sequenced PR-sized batches. Each batch = one branch segment or focused commit group.

---

## Batch 0 — Documentation / truth pass ✅

**Goal:** Repo inventory, finding register, design synthesis docs, baseline checks.

**Deliverables:**
- `docs/audits/adversarial-rescue-*.md` (4 files)
- `docs/design/*.md` (8 files)
- Baseline: tsc ✅ lint ✅ test 341/341 ✅

**No runtime patches** except branch creation.

---

## Batch 1 — Theme / rendering / icon foundation 🔄

**Goal:** Tokenize atmospheric + companion colors; wire Lucide nav icons; honest notification copy.

**Files (target):**
- `src/app/globals.css` — `--axis-*` iridescent + companion tokens
- `src/components/ui/Icon.tsx` — new primitive
- `src/lib/icons/nav-icons.ts` — semantic map
- `src/components/nav/Sidebar.tsx` — Lucide nav icons
- `src/components/layout/Mascot.tsx` — Nova tokenization
- `src/components/theme/InterfaceStudioDrawer.tsx` — notification honesty

**Findings addressed:** AR-010, AR-011 (partial), AR-012

**Checks:** tsc, lint, test, theme QA unit tests

**Deferred:** Full icon migration (status icons, widgets, modules)

---

## Batch 2 — Shared UX primitives + widget foundation

**Goal:** Status icon semantics; widget shell glass tokens; `StatusCallout` consistency.

**Files (target):**
- `src/components/ui/Icon.tsx` — status/action presets
- `src/lib/icons/status-icons.ts`
- `src/components/widgets/WidgetShell.tsx`
- Extend Lucide to widget action bar

**Findings:** AR-034 (widget drill-in prep)

---

## Batch 3 — Console / widget data architecture

**Goal:** Widget click-through routes; stale-while-revalidate labels; reduce first-paint fan-out.

**Files:** `ConsoleModule.tsx`, `useWidgetData.ts`, `widget-grid-model`

---

## Batch 4 — Daily production modules (Mail focus)

**Goal:** Composio `accountId` threading; mail action route parity; load error surfaces for People/Pipeline/Library.

**Findings:** AR-002, AR-016, AR-019

**Linear alignment:** AGENTS.md items 2–7 (Mail vertical slice)

---

## Batch 5 — Beta planning / research modules

**Goal:** Briefing silent failures; Literature prefs; Debrief loading state; Pipeline error surfaces.

**Findings:** AR-013–AR-017

---

## Batch 6 — Life / capital beta

**Goal:** Fund provider-unavailable polish; People contacts parity validation.

---

## Batch 7 — Lab / immature modules

**Goal:** Vitality localStorage removal; Supper Club honest state or persistence; workout log Supabase.

**Findings:** AR-004, AR-005, AR-040

---

## Batch 8 — Control Room / AI / production hardening

**Goal:** Composio execute lockdown; AI mode allowlist; Gemini key header; migration plan doc.

**Findings:** AR-001, AR-003, AR-018, AR-020

---

## Batch 9 — Visual regression + release candidate

**Goal:** Cross-theme QA matrix execution; e2e smoke expansion; build + preview validation.

---

## PR strategy

- One PR per batch where possible
- Current branch: `cursor/adversarial-rescue-audit-c4ca`
- Split into focused PRs if batch exceeds ~400 LOC changed
