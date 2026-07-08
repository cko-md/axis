# AXIS Adversarial Rescue — Finding Register

> Living register. Updated per patch batch. Severity: P0 blocking · P1 major · P2 meaningful · P3 polish

---

## P0 — Production-blocking

### AR-001 ✅
- **Status:** Fixed — Composio execute allowlist, rate limit, stripped response
- **Patch batch:** 8

### AR-002 ✅
- **Status:** Fixed — `connectedAccountId` + `mailAccountQuery` + action `accountId`
- **Patch batch:** 4

### AR-003 ✅
- **Status:** Fixed — AI mode allowlist
- **Patch batch:** 8

### AR-004 ✅
- **Status:** Fixed — Vitality hooks surface `loadError` (no silent localStorage for signed-in DB errors)
- **Patch batch:** 7

### AR-005 ✅ (mitigated)
- **Status:** Mitigated — explicit lab persistence banner; full Supabase slice deferred
- **Patch batch:** 7

---

## P1 — Major

### AR-010 ✅ — Notification honesty (Batch 1)
### AR-011 ✅ — Lucide nav + status + command palette icons (Batches 1–2)
### AR-012 ✅ — Nova tokenization (Batch 1)
### AR-013 ✅ — Literature prefs warn on local fallback (already in `useLiterature` + module banner)
### AR-014 ✅ — Briefing feed error callout (Batch 5)
### AR-015 ✅ — Curated story prefix (Batch 5)
### AR-016 ✅ — People/Pipeline/Library load errors (Batch 4)
### AR-017 ✅ — Debrief loading skeletons (Batch 5)
### AR-018 📋 — Migration renumber plan documented (`docs/audits/migration-renumber-plan.md`); apply requires human gate
### AR-019 🔄 — Outlook Composio detail slugs defensive; live verification still human step
### AR-020 ✅ — Gemini key via `x-goog-api-key` header (Batch 8)

---

## P2 — Meaningful quality

### AR-034 ✅ — Widget navigate/drawer verified
### AR-035 ✅ — Mail inbox pagination + Load more (per-account)
### AR-038 ✅ — Objectives scan returns visible errors
### AR-039 ✅ — Agenda routine check persist surfaces toast on failure
### AR-040 ✅ — Workout logs → Supabase `workout_logs` + `useWorkoutLog`

### AR-030–033, AR-036–037 — Deferred (out of rescue scope; track in Linear)

---

## P3 — Polish / future

### AR-050–054 — Deferred (README, god-components, untyped Supabase client partial workaround for workout_logs)

---

## Deferred / blocked

| ID | Blocker |
|----|---------|
| AR-018 apply | Human approval + prod migration validation |
| Vercel/Sentry remote | Preview deploy + MCP credentials |
| Tembo | Role unspecified |
