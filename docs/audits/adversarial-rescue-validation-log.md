# AXIS Adversarial Rescue — Validation Log

> Evidence per batch. Do not claim validation without entries here.

---

## Batch 0 — 2026-07-08

### Automated checks

| Command | Result | Notes |
|---------|--------|-------|
| `npx tsc --noEmit` | ✅ Pass | Node 24 via nvm |
| `npm run lint` | ✅ Pass | 1 warning: `text-effect.tsx:183` unused `_` |
| `npm run test` | ✅ 341/341 | 53 files, 2.88s |
| `npm run build` | ⏭ Deferred | Post Batch 1 patches |

### Manual / remote

| System | Status | Steps |
|--------|--------|-------|
| Vercel preview | ⏭ Not run | Push branch → verify preview build → exercise `/command`, `/mail`, themes |
| Sentry | ⏭ Not run | Query preview env for new issues after Batch 1 deploy |
| Supabase remote | ⏭ Not run | No migration changes in Batch 0–1 |
| Tembo | N/A | Role unspecified |
| E2E Playwright | ⏭ Not run | Scheduled Batch 9 |

### Cross-theme (Batch 0)

Static CSS review only — light theme already silver/chrome per `html.light` block in `globals.css`. Full matrix deferred to Batch 9.

---

## Batch 1 — 2026-07-08 ✅

### Automated checks

| Command | Result | Notes |
|---------|--------|-------|
| `npx tsc --noEmit` | ✅ Pass | |
| `npm run lint` | ✅ Pass | 1 pre-existing warning `text-effect.tsx` |
| `npm run test` | ✅ 343/343 | +2 nav-icons tests |
| `npm run build` | ⚠️ Fail (pre-existing) | Missing `NEXT_PUBLIC_SUPABASE_*` in build env |

### Sentry impact

None expected — no new capture paths.

### Supabase / RLS impact

None — no schema changes.

---

## Batches 2–8 — 2026-07-08 ✅

### Scope delivered

| Batch | Findings | Key changes |
|-------|----------|-------------|
| 2 | AR-011, AR-034 | Command palette Lucide icons; status icons (prior commit) |
| 3 | AR-034 | Widget registry navigate/drawer actions verified (no code change) |
| 4 | AR-002, AR-016, AR-019 | `mailAccountQuery`, Composio `connectedAccountId`, mail action `accountId`, People/Pipeline/Library `loadError` |
| 5 | AR-013–AR-015 | Briefing `feedLoadError` callout; Debrief stops demo data during signed-in load |
| 6 | AR-017 | Fund provider states already present — no change |
| 7 | AR-004, AR-005 | Vitality hooks surface `loadError`; Supper Club lab banner already present |
| 8 | AR-001, AR-003, AR-018 | Composio execute allowlist + rate limit; AI mode allowlist; Gemini key via `x-goog-api-key` header |

### Automated checks

| Command | Result | Notes |
|---------|--------|-------|
| `npx tsc --noEmit` | ✅ Pass | Node 24 |
| `npm run lint` | ✅ Pass | 1 pre-existing warning |
| `npm run test` | ✅ 356/356 | +13 new tests (mail query, AI modes, composio allowlist, palette icons, composio accountId) |
| `npm run build` | ⚠️ Blocked | `NEXT_PUBLIC_SUPABASE_*` not set in cloud VM — pre-existing |

### Supabase / Tembo impact

None — no migrations.

### Sentry impact

Composio execute route captures connection/list and tool failures with safe tags only.

---

## Batch 9 — 2026-07-08 ✅ (local)

### Remaining risks closed

| Risk | Resolution |
|------|------------|
| AR-040 WorkoutDetailModal localStorage | `050_workout_logs.sql` + `useWorkoutLog` + Supabase persistence |
| AR-038 Objectives scan silent failure | `scanForObjectives` returns `{ results, error }`; UI + cron updated |
| AR-039 Agenda routine `.catch(() => {})` | Toast on Supabase sync failure |
| AR-035 Mail Composio pagination | `listComposioInbox` page tokens + Mail Load more |
| Composio allowlist drift | `composio-mail-tools.ts` single source + parity test |
| AR-018 migration chaos | `docs/audits/migration-renumber-plan.md` (human gate) |
| E2E / cross-theme | `adversarial-rescue.spec.ts` added; `console-theme-rendering.spec.ts` exists |
| Vitality logs load errors | `useVitalityLogs` + nutrition protocol errors surfaced |

### Automated checks

| Command | Result | Notes |
|---------|--------|-------|
| `npx tsc --noEmit` | ✅ Pass | workout_logs via untyped store until types regen |
| `npm run lint` | ✅ Pass | 5 warnings (pre-existing text-effect + WorkoutDetailModal deps) |
| `npm run test` | ✅ 360/360 | +4 new test files |
| `npm run build` | ⚠️ Blocked | `NEXT_PUBLIC_SUPABASE_*` not in cloud VM |
| `npm run test:e2e` | ⚠️ Blocked | Playwright webServer needs Supabase env vars |

### Database / Supabase impact

- **New migration:** `050_workout_logs.sql` (RLS owner-scoped, unique user+session)
- Apply via standard migration workflow before using workout log sync in prod
- Tembo: N/A

### Vercel preview validation (human)

- [ ] Apply migration `050_workout_logs.sql` on preview Supabase
- [ ] Vitality → open workout detail → save log → reload persists
- [ ] Mail → filter single account → Load more
- [ ] Objectives → Platform scan → error/empty states visible
- [ ] Agenda → routine check toggle with Supabase outage shows toast

### Sentry validation (post-preview)

Query preview for `workout_logs`, `objectives/scan`, `composio/execute` regressions.

