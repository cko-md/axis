# AXIS Adversarial Rescue — Finding Register

> Living register. Updated per patch batch. Severity: P0 blocking · P1 major · P2 meaningful · P3 polish

---

## P0 — Production-blocking

### AR-001
- **Phase:** Batch 0
- **Module:** Integrations / Composio
- **File:** `src/app/api/integrations/composio/execute/route.ts`
- **Problem:** Authenticated arbitrary Composio tool execution; no allowlist, no rate limit; raw provider data returned
- **Severity:** P0
- **Risk:** security / privacy
- **Recommended fix:** Allowlist tools per toolkit, rate limit, strip response payloads
- **Patch batch:** 8

### AR-002
- **Phase:** Batch 0
- **Module:** Mail
- **File:** `src/lib/mail/findAccount.ts`, `src/components/mail/MailModule.tsx`
- **Problem:** Multi-Composio-account ambiguity; UI omits `accountId`; placeholder `"Connected account"` breaks resolution
- **Severity:** P0
- **Risk:** integration / UX
- **Recommended fix:** Thread `connectedAccountId` through inbox/detail/action fetches
- **Patch batch:** 4

### AR-003
- **Phase:** Batch 0
- **Module:** AI
- **File:** `src/lib/ai/request.ts`, `src/app/api/ai/route.ts`
- **Problem:** `/api/ai` mode not allowlisted; unknown modes default to `capture` and invoke LLM
- **Severity:** P0
- **Risk:** security / cost
- **Recommended fix:** Strict mode enum validation
- **Patch batch:** 8

### AR-004
- **Phase:** Batch 0
- **Module:** Vitality
- **File:** `src/lib/hooks/useTrainingWeek.ts`, `useFitnessRoutines.ts`, `useNutritionProtocol.ts`
- **Problem:** Signed-in users silently fall back to localStorage on DB errors
- **Severity:** P0
- **Risk:** data / UX
- **Recommended fix:** Surface error; block silent degrade for authenticated users
- **Patch batch:** 7

### AR-005
- **Phase:** Batch 0
- **Module:** Supper Club
- **File:** `src/components/supper-club/SupperClubModule.tsx`
- **Problem:** No Supabase persistence; entire module is localStorage + static recipes
- **Severity:** P0
- **Risk:** data / UX
- **Recommended fix:** Migration + RLS or explicit demo-only nav gating
- **Patch batch:** 7

---

## P1 — Major

### AR-010
- **Module:** Design / Interface Studio
- **File:** `src/components/theme/InterfaceStudioDrawer.tsx`
- **Problem:** Notification toggles persisted but never consumed — misleading
- **Status:** **Mitigated Batch 1** — honest delivery label added
- **Patch batch:** 1 ✅

### AR-011
- **Module:** Iconography
- **File:** `package.json`, `src/components/nav/Sidebar.tsx`
- **Problem:** `lucide-react` installed but unused; fragmented inline SVGs
- **Status:** **In progress Batch 1** — `Icon` primitive + nav Lucide map
- **Patch batch:** 1 🔄

### AR-012
- **Module:** Presence / Nova
- **File:** `src/components/layout/Mascot.tsx`
- **Problem:** Hardcoded `#16B8F3` / `#a8ecff` — theme-deaf
- **Status:** **Fixed Batch 1** — `--companion-nova-*` tokens
- **Patch batch:** 1 ✅

### AR-013
- **Module:** Literature
- **File:** `src/lib/hooks/useLiterature.ts`
- **Problem:** Prefs silently degrade to localStorage
- **Patch batch:** 5

### AR-014
- **Module:** Briefing
- **File:** `src/components/briefing/BriefingModule.tsx:281`
- **Problem:** Feed refresh `.catch(() => {})` — silent failure
- **Patch batch:** 5

### AR-015
- **Module:** Briefing
- **File:** `src/components/briefing/BriefingModule.tsx`
- **Problem:** Hardcoded `STORIES` merged into live feed without curated label
- **Patch batch:** 5

### AR-016
- **Module:** Hooks
- **File:** `src/lib/hooks/usePeople.ts`, `usePipeline.ts`, `useLibraryFiles.ts`
- **Problem:** Load errors ignored; empty list shown
- **Patch batch:** 4

### AR-017
- **Module:** Debrief
- **File:** `src/components/debrief/DebriefModule.tsx`
- **Problem:** `DEMO_WINS`/`DEMO_FRICTION` flash during signed-in load
- **Patch batch:** 5

### AR-018
- **Module:** Migrations
- **File:** `supabase/migrations/`
- **Problem:** Duplicate prefixes (011, 020, 036), unnumbered files, policy conflicts
- **Patch batch:** 8 (non-destructive renumber — human gate)

### AR-019
- **Module:** Mail / Composio
- **File:** `src/lib/mail/adapters/outlook-composio.ts`
- **Problem:** Outlook detail tool slugs not live-verified
- **Patch batch:** 4

### AR-020
- **Module:** AI
- **File:** `src/lib/ai/router.ts`
- **Problem:** Gemini API key in URL query string
- **Patch batch:** 8

---

## P2 — Meaningful quality

### AR-030 — Monolithic globals.css (~5k LOC); hybrid Tailwind + CSS modules
### AR-031 — DESIGN_HANDOFF.md stale (sidebar persistence, WebViewer location)
### AR-032 — Legacy `.mascot` CSS orphaned
### AR-033 — `dataset.companion`/`dataset.tone` written but unused in CSS selectors
### AR-034 — Console widgets not clickable to detail routes
### AR-035 — Mail Composio pagination ignored
### AR-036 — Composio reply not threaded (new message warning only)
### AR-037 — Health device OAuth dead-end (connect routes, no callbacks)
### AR-038 — Objectives scan fails silently
### AR-039 — Agenda routine persist `.catch(() => {})`
### AR-040 — WorkoutDetailModal logs localStorage-only

---

## P3 — Polish / future

### AR-050 — Duplicate routes `/console`↔`/command`, `/signals`↔`/dispatch`
### AR-051 — README materially stale
### AR-052 — Module god-components >700 LOC (Vitality 1935, Notes 1329)
### AR-053 — Objectives/Pipeline/Agenda shallow detail views
### AR-054 — Supabase clients untyped (no `Database` generic)

---

## Deferred / blocked

| ID | Blocker |
|----|---------|
| AR-018 | Destructive migration renumber requires human approval + prod validation |
| Vercel/Sentry remote validation | MCP credentials not exercised in Batch 0 |
| Tembo | Role unspecified in repo |
