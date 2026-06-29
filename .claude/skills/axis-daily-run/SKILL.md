---
name: axis-daily-run
description: "Daily health check, security scan, cleanup, and maintenance automation for the Axis personal OS platform. Runs sub-components in sequence and produces a compact daily status report. Has a cloud component (GitHub Actions + Vercel cron) that runs at 7:00 AM UTC daily regardless of whether Claude Desktop is open."
category: ops
requires:
  bins: [npx, curl, git]
---

# Axis Daily Run — Platform Maintenance Automation

You are the daily maintenance agent for the **Axis[CKO] personal OS** platform.

This is a structured automation with sub-components. Run them in order, collect results, and produce a final status report. Work from the project root: `/Users/ogo.ko/Projects/axis`.

> **Cloud automation note:** A GitHub Actions workflow (`.github/workflows/daily-health.yml`) runs at 7:00 AM UTC daily and independently triggers the Vercel cron endpoint, runs `tsc --noEmit`, and runs `npm audit`. It creates a GitHub issue automatically if any check fails. The Vercel cron also runs at 6:00 AM UTC (configured in `vercel.json`). This skill is for interactive / ad-hoc runs and deeper investigation.

---

## Orchestrator — Coordinated Cloud + Local Check

When invoked, the orchestrator runs these phases in order:

### Phase A — Trigger & verify cloud cron
```bash
# 1. Trigger the Vercel cron endpoint
if [ -f /Users/ogo.ko/Projects/axis/.env.local ]; then
  CRON_SECRET=$(grep CRON_SECRET /Users/ogo.ko/Projects/axis/.env.local | cut -d= -f2 | tr -d '"')
  if [ -n "$CRON_SECRET" ]; then
    CRON_RESULT=$(curl -sf -w "\nHTTP:%{http_code}" \
      -H "Authorization: Bearer $CRON_SECRET" \
      "https://axis-cko.vercel.app/api/cron/daily" 2>&1)
    echo "Cron result: $CRON_RESULT"
  else
    echo "No CRON_SECRET found — cron runs automatically via Vercel/GitHub Actions schedule"
  fi
fi

# 2. Check latest GitHub Actions run status
gh run list --workflow=daily-health.yml --limit=3 --json status,conclusion,startedAt,url \
  2>/dev/null | jq -r '.[] | "\(.startedAt) \(.status) \(.conclusion // "running") \(.url)"' \
  || echo "(gh CLI not authenticated or no runs yet)"
```

### Phase B — Local TypeScript + security
Run sub-components 2 and 3 (TypeScript check and security scan) locally to catch anything not yet pushed.

### Phase C — Self-review analytics (last 7 days)
Use the Supabase MCP if available:
- Query `health_check_runs` for the last 7 days: `SELECT ran_at, all_ok, supabase_health, dependency_check FROM health_check_runs ORDER BY ran_at DESC LIMIT 7`
- Summarize trends: consecutive failures, packages consistently behind, Supabase health pattern
- Flag degrading patterns: if `all_ok = false` for 2+ consecutive runs, escalate to P0

If Supabase MCP unavailable, skip Phase C and note it in the report.

---

## Sub-component 1 — Deployment Health Check

Verify the production deployment is alive and key routes respond correctly.

```bash
# Ping the production URL
curl -sf -o /dev/null -w "%{http_code}" https://axis-cko.vercel.app/ | grep -q "200\|302" && echo "✓ Root: OK" || echo "✗ Root: FAIL"

# Check key API routes (public ones, no auth needed)
curl -sf -o /dev/null -w "%{http_code}" "https://axis-cko.vercel.app/api/widgets/weather?lat=40.71&lon=-74.01" | grep -q "200\|400" && echo "✓ Weather API: reachable" || echo "✗ Weather API: FAIL"
curl -sf -o /dev/null -w "%{http_code}" "https://axis-cko.vercel.app/api/gallery?source=aic" | grep -q "200\|429" && echo "✓ Gallery API: reachable" || echo "✗ Gallery API: FAIL"
```

If any critical route fails, flag as **P0 — immediate attention needed**.

---

## Sub-component 2 — TypeScript Integrity Check

Catch type regressions before they reach production.

```bash
cd /Users/ogo.ko/Projects/axis
npx tsc --noEmit 2>&1 | head -40
```

- Zero errors = green
- Errors in `src/app/api/` or `src/lib/` = flag as high priority
- Errors in `src/components/` = flag as medium priority

---

## Sub-component 3 — Security Vulnerability Scan

```bash
cd /Users/ogo.ko/Projects/axis
npm audit --audit-level=moderate 2>&1 | tail -20
```

Also check for accidental secret exposure:
```bash
grep -rn "NEXT_PUBLIC_" /Users/ogo.ko/Projects/axis/src/app/api/ 2>/dev/null | grep -v "SUPABASE_URL\|SUPABASE_ANON_KEY\|APP_URL" && echo "⚠ Possible secret exposure in API routes" || echo "✓ No NEXT_PUBLIC_ in API routes"
grep -rn "sk_\|pk_live_\|service_role" /Users/ogo.ko/Projects/axis/src/ 2>/dev/null | grep -v ".env\|node_modules\|test" && echo "⚠ Possible hardcoded key" || echo "✓ No hardcoded keys detected"
```

---

## Sub-component 4 — Platform Cleanup (Cron Trigger)

Trigger the daily maintenance cron — cleans expired WebAuthn challenges, old inbox entries, stale AI signals, and stores the run result in `health_check_runs`.

```bash
# Read CRON_SECRET from local env if available, otherwise skip
if [ -f /Users/ogo.ko/Projects/axis/.env.local ]; then
  CRON_SECRET=$(grep CRON_SECRET /Users/ogo.ko/Projects/axis/.env.local | cut -d= -f2 | tr -d '"')
  if [ -n "$CRON_SECRET" ]; then
    RESULT=$(curl -sf -X GET https://axis-cko.vercel.app/api/cron/daily \
      -H "Authorization: Bearer $CRON_SECRET" \
      -H "Content-Type: application/json" \
      -w "\nHTTP:%{http_code}" 2>&1)
    echo "Cron result: $RESULT"
  else
    echo "⚠ CRON_SECRET not found in .env.local — skipping remote cron trigger"
  fi
else
  echo "ℹ No .env.local — cron runs automatically via Vercel schedule (6AM UTC) and GitHub Actions (7AM UTC)"
fi
```

---

## Sub-component 5 — Build Size & Bundle Analysis

Track that the build isn't ballooning.

```bash
cd /Users/ogo.ko/Projects/axis

# Quick build check (uses cache) — just verify compilation succeeds
npx next build 2>&1 | grep -E "✓|✗|error|Error|warning|Route|First Load" | tail -30
```

Flag if `First Load JS shared` exceeds 200 kB.

---

## Sub-component 6 — Git Hygiene

Ensure the repo is clean and no sensitive files have drifted in.

```bash
cd /Users/ogo.ko/Projects/axis

echo "=== Working tree ==="
git status --short

echo "=== Recent commits (last 24h) ==="
git log --since="24 hours ago" --oneline

echo "=== Check for .env files accidentally staged ==="
git ls-files | grep -E "\.env|secret|credential" && echo "⚠ Sensitive files tracked!" || echo "✓ No .env files in git"

echo "=== Unmerged branches ==="
git branch -r --merged main | grep -v "HEAD\|main" | head -5
```

---

## Sub-component 7 — Dependency Freshness

```bash
cd /Users/ogo.ko/Projects/axis
npm outdated 2>&1 | head -30
```

Flag any package with a **major** version drift (Current: 1.x, Latest: 2.x). Minor/patch drift is informational only.

Key packages to watch: `next`, `@supabase/supabase-js`, `@simplewebauthn/server`, `@simplewebauthn/browser`.

The Vercel cron also checks `next`, `@supabase/ssr`, and `anthropic` against the npm registry on each run and stores results in `health_check_runs.dependency_check`.

---

## Sub-component 8 — Supabase Health Snapshot

Check for obvious Supabase issues by reading recent auth/cleanup patterns.

Use the Supabase MCP if available, or run:
```bash
# Check migration files are in sync
ls /Users/ogo.ko/Projects/axis/supabase/migrations/ | sort
```

If Supabase MCP tools are available (`mcp__6cc757bc-fad2-4294-869d-c2c7e4f15764__*`):
- Run `list_tables` on project `twkcvyhmlguipchfetge` to verify all expected tables exist (including `health_check_runs`)
- Check `webauthn_challenges` for any rows with `expires_at` far in the future (cleanup not running)
- Spot-check `user_passkeys` row count for sanity

---

## Sub-component 9 — Self-Review Analytics

Fetch the last 7 days of `health_check_runs` from Supabase and summarize trends.

If Supabase MCP is available, execute:
```sql
SELECT
  ran_at,
  all_ok,
  supabase_health->>'ok' AS db_ok,
  dependency_check
FROM health_check_runs
ORDER BY ran_at DESC
LIMIT 7;
```

Analyze:
- **Consecutive failures**: if `all_ok = false` for 2+ rows in a row, flag as P0
- **Dependency drift**: if a package shows `behind: true` for 3+ consecutive runs, surface it as an action item
- **Supabase instability**: if `supabase_health.ok = false` appears more than once in the window, escalate
- **Run frequency**: if fewer than 5 runs appear in the last 7 days, the cloud cron may have stopped — check GitHub Actions

---

## Sub-component 10 — Memory & Context Update

After running all sub-components, update the project memory if anything notable changed:

- If a new vulnerability was found → save to `/Users/ogo.ko/.claude/projects/-Users-ogo-ko-Projects-axis/memory/`
- If a new pattern emerged (recurring error type, dependency issue) → log it
- If deployment health degraded → note it

---

## Final Output — Daily Status Report

Produce a compact status report in this format:

```
═══════════════════════════════════════
AXIS[CKO] Daily Status — [DATE]
═══════════════════════════════════════

🟢 HEALTHY   / 🟡 ATTENTION  / 🔴 ACTION REQUIRED

Cloud cron:     [last run status from health_check_runs or GitHub Actions]
Deployment:     [status]
TypeScript:     [status — X errors or clean]
Security:       [status — X vulns or clean]
Build:          [status — bundle size]
Git:            [status — N commits, clean/dirty]
Dependencies:   [status — N outdated, any behind from cron check]
Supabase:       [status]
Cron cleanup:   [status]
7-day trend:    [green/degrading/unknown]

── Action Items ──────────────────────
[List any items needing attention, ordered by severity]

── Informational ─────────────────────
[Low-priority observations]
═══════════════════════════════════════
```

If everything is green, the report should take under 10 seconds to read.
If there are action items, be specific about what file/command resolves each one.
