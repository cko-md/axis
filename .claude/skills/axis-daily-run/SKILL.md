---
name: axis-daily-run
description: "Daily health check, security scan, cleanup, and maintenance automation for the Axis personal OS platform. Runs sub-components in sequence and produces a compact daily status report."
category: ops
requires:
  bins: [npx, curl, git]
---

# Axis Daily Run — Platform Maintenance Automation

You are the daily maintenance agent for the **Axis[CKO] personal OS** platform.

This is a structured automation with sub-components. Run them in order, collect results, and produce a final status report. Work from the project root: `/Users/ogo.ko/Projects/axis`.

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

Trigger the daily maintenance cron — cleans expired WebAuthn challenges, old inbox entries, stale AI signals.

```bash
# Read CRON_SECRET from local env if available, otherwise skip
if [ -f /Users/ogo.ko/Projects/axis/.env.local ]; then
  CRON_SECRET=$(grep CRON_SECRET /Users/ogo.ko/Projects/axis/.env.local | cut -d= -f2 | tr -d '"')
  if [ -n "$CRON_SECRET" ]; then
    RESULT=$(curl -sf -X POST https://axis-cko.vercel.app/api/cron/daily \
      -H "Authorization: Bearer $CRON_SECRET" \
      -H "Content-Type: application/json" \
      -w "\nHTTP:%{http_code}" 2>&1)
    echo "Cron result: $RESULT"
  else
    echo "⚠ CRON_SECRET not found in .env.local — skipping remote cron trigger"
  fi
else
  echo "ℹ No .env.local — cron runs automatically via Vercel schedule"
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

---

## Sub-component 8 — Supabase Health Snapshot

Check for obvious Supabase issues by reading recent auth/cleanup patterns.

Use the Supabase MCP if available, or run:
```bash
# Check migration files are in sync
ls /Users/ogo.ko/Projects/axis/supabase/migrations/ | sort
```

If Supabase MCP tools are available (`mcp__6cc757bc-fad2-4294-869d-c2c7e4f15764__*`):
- Run `list_tables` on project `twkcvyhmlguipchfetge` to verify all expected tables exist
- Check `webauthn_challenges` for any rows with `expires_at` far in the future (cleanup not running)
- Spot-check `user_passkeys` row count for sanity

---

## Sub-component 9 — Memory & Context Update

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

Deployment:     [status]
TypeScript:     [status — X errors or clean]
Security:       [status — X vulns or clean]
Build:          [status — bundle size]
Git:            [status — N commits, clean/dirty]
Dependencies:   [status — N outdated]
Supabase:       [status]
Cron cleanup:   [status]

── Action Items ──────────────────────
[List any items needing attention, ordered by severity]

── Informational ─────────────────────
[Low-priority observations]
═══════════════════════════════════════
```

If everything is green, the report should take under 10 seconds to read.
If there are action items, be specific about what file/command resolves each one.
