# 14 — Observability & Dashboards (§13)

This is the operational spec for watching the operate loop in production. It
does two things:

1. Defines the **structured events** the system emits (source of truth: the
   `emitServerEvent` call sites), and
2. Specifies the **Sentry / log dashboards** built from those events, as
   copy-pasteable queries — so the dashboards can be recreated deterministically
   rather than hand-assembled.

Dashboards themselves are UI artifacts in Sentry and can't be committed to the
repo; this doc is the committed, reviewable definition they're built from.

---

## 1. Emitted events

All events go through `emitServerEvent(event, fields)` in
`src/lib/observability/events.ts`, which:

- stamps `event` + ISO `ts`,
- **redacts** any sensitive-looking key (token/secret/password/auth/cookie/api
  key/email/phone/account-number/…) via `redactSafe`, defensively, regardless
  of caller discipline, and
- writes one JSON line to the server log (captured by Vercel; also visible to
  Sentry's logs if enabled).

Events are **info-level operational signals**. Exceptions are still captured
separately by Sentry's error pipeline — this stream is for *expected* lifecycle
transitions, not crashes.

### Event catalogue

| Event | Emitted from | Safe fields | Purpose |
|-------|--------------|-------------|---------|
| `approval.decided` | `PATCH /api/approvals/[id]` (approve/deny) | `approvalId`, `decision` (`approved`\|`denied`), `actionClass`, `requirement`, `decisionLatencyMs` | Approval decision throughput + latency |
| `approval.executed` | `PATCH /api/approvals/[id]` (execute) | `approvalId`, `actionClass`, `requirement`, `stepUpRequired`, `executeLatencyMs` | Actionable-gate clears; approve→execute window |
| `approval.step_up_verified` | `POST /api/approvals/[id]/step-up?action=verify` | `approvalId` | Passkey step-up success rate |
| `routine.run.completed` | `POST /api/routines/concentration-check`, `…/rebalance-proposal` | `routine`, `runId`, `status`, + routine-specific counts | Routine success |
| `routine.run.blocked` | `POST /api/routines/concentration-check`, `…/rebalance-proposal` | `routine`, `runId`, `error`, optional safe operation/count metadata | Routine step failed or required data was incomplete |

**Invariant:** no event carries `proposed_action`, holdings, prices, balances,
or any PII. Only IDs, enums (action class / requirement / status), booleans, and
durations. This is enforced structurally by `redactSafe` and by keeping call
sites to the fields listed above. Any new field must be an ID, enum, boolean,
count, or duration — never free financial content.

---

## 2. Dashboards

Each widget below is a saved query over the event stream (Sentry log search
syntax; the same predicates work against the raw JSON logs in Vercel). Group
the four widget groups into one "Axis — Operate Loop" dashboard.

### 2.1 Approval reliability & latency

- **Decision volume (24h), split by decision**
  `event:approval.decided` — group by `decision`, count. Watch for a spike in
  `denied` (proposals users don't trust) or a collapse to zero (loop stalled).
- **Decision latency p50/p95**
  `event:approval.decided` — percentile of `decisionLatencyMs`. This is how long
  approvals sit before a human acts. Rising p95 = the queue is being ignored.
- **Execute clears vs. decisions**
  Ratio of `event:approval.executed` to `event:approval.decided decision:approved`.
  A gap means approved items never got executed (stuck at step-up, or expired).
- **Approve→execute window p95**
  `event:approval.executed` — percentile of `executeLatencyMs`. Feeds the
  step-up freshness policy: if p95 approaches `STEP_UP_MAX_AGE_MS` (5 min), users
  are routinely hitting `STEP_UP_STALE` and re-verifying.

### 2.2 Step-up security

- **Step-up success count**
  `event:approval.step_up_verified` — count over 24h, split by nothing (each is
  a verified passkey assertion).
- **Step-up failure rate** (from HTTP, not this stream): alert on a burst of
  `429 TOO_MANY_ATTEMPTS` or `400 NOT_VERIFIED` on `…/step-up` — brute-force
  signal. Pair with the rate-limit metric.
- **Executed-with-step-up share**
  `event:approval.executed stepUpRequired:true` vs total executed — confirms the
  high-risk classes are actually going through step-up, not slipping the gate.

### 2.3 Routine reliability

- **Run outcomes (24h)**
  `event:routine.run.*` — group by the event suffix
  (`completed`/`paused`/`blocked`), split by `routine`. `blocked` is the error
  budget; alert if `blocked / (completed+paused+blocked) > 5%` per routine.
- **Blocked run reasons**
  `event:routine.run.blocked` — group by `error` (already a short, redacted
  string). Top-N of this list is the routine bug backlog.
- **Pause depth**
  `event:routine.run.paused` — sum of `approvals`. How many approvals the loop is
  generating and therefore how much human review it's asking for.

### 2.4 Integration & cost health

- **AI cost per run** (from `routine_runs.actual_cost_usd`, not the event
  stream): a table/timeseries of `sum(actual_cost_usd)` per day and per
  `routine_key`. The estimator (`src/lib/ai/cost.ts`) is labeled approximate;
  this is a budget signal, not billing. Alert on a day-over-day jump.
- **Integration errors** (from Sentry's error pipeline): filter captured
  exceptions/`IntegrationError` by `code` (RATE_LIMITED / UNAUTHORIZED /
  UPSTREAM_UNAVAILABLE / …) and by provider (polygon / plaid). This is adapter
  health; a spike in `UPSTREAM_UNAVAILABLE` explains routine `blocked` runs and
  stale freshness badges.

---

## 3. Alerts (minimum set)

| Alert | Condition | Why |
|-------|-----------|-----|
| Routine error budget | `blocked` share > 5% over 1h, any routine | A routine is broken |
| Approval queue stalling | `approval.decided` p95 `decisionLatencyMs` > 24h | Nobody is acting on approvals |
| Step-up brute force | > 20 `4xx` on `…/step-up` per user per 10m | Abuse / credential attack |
| AI cost jump | daily `sum(actual_cost_usd)` > 2× trailing-7d median | Runaway model usage |
| Integration outage | > 10 `UPSTREAM_UNAVAILABLE` per provider per 10m | Provider down; freshness degrading |

---

## 4. How to build it

1. In Sentry (org `kevin-ogonuwe`, region `https://us.sentry.io`), enable Logs
   for the project if not already, or point the dashboard at the Vercel log
   drain.
2. Create dashboard **"Axis — Operate Loop"** with the four widget groups in §2.
3. Add the §3 alert rules.
4. Keep this doc in sync with the `emitServerEvent` call sites — the event
   catalogue table (§1) is the contract. When you add or rename an event, update
   the table in the same PR.
