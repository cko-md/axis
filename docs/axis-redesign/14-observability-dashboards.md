# 14 — Observability & Dashboards (§13)

This is the committed operational contract for the AXIS operate loop. It
defines the events emitted by the application and the exact queries/operators
must use to recreate production monitoring. It does **not** claim that a Sentry
dashboard, alert, or Vercel log drain has been created.

The implementation source of truth is
`src/lib/observability/events.ts`; this document must change in the same PR as
that catalogue.

---

## 1. Privacy and schema contract

`emitServerEvent` is a closed, typed event API:

- only catalogue names are accepted;
- every payload is parsed by a strict schema, so unknown fields are rejected;
- string values are limited to UUIDs and fixed enums/codes;
- counts and durations are bounded non-negative integers;
- each call carries a server-generated `requestId`, and the event envelope adds
  server-generated `eventId`, `schemaVersion`, and ISO `ts` metadata;
- proposed actions, holdings, symbols, prices, balances, messages, provider
  payloads, and PII have no event field and therefore cannot be emitted.

If a caller bypasses TypeScript or supplies a malformed value, the application
does not throw into the user workflow. It writes only:

```json
{"event":"observability.event.rejected","eventId":"<uuid>","schemaVersion":1,"ts":"<iso>","reason":"invalid_payload"}
```

The rejected name and payload are deliberately not echoed. Exceptions and
unexpected route failures still use `captureRouteError` and Sentry separately.

### Event catalogue

| Event | Emitted from | Exact safe fields |
|---|---|---|
| `approval.decided` | `PATCH /api/approvals/[id]` | `requestId`, `approvalId`, `decision`, `actionClass`, `requirement`, `decisionLatencyMs` |
| `approval.executed` | `PATCH /api/approvals/[id]` | `requestId`, `approvalId`, `actionClass`, `requirement`, `stepUpRequired`, `executeLatencyMs` |
| `approval.step_up_verified` | `POST /api/approvals/[id]/step-up?action=verify` | `requestId`, `approvalId` |
| `routine.run.completed` | concentration start/continue/resume and rebalance simulation | `requestId`, `routine`, `runId`, `status`; concentration adds bounded breach/task counts and `resumedFromApproval`; rebalance adds proposal count plus fixed simulation/non-submission flags |
| `routine.run.blocked` | concentration start/continue/resume and rebalance simulation | `requestId`, `routine`, optional `runId`, fixed `errorCode`, fixed `stage`, `resumedFromApproval` |

There is no `routine.run.paused` event. A routine waiting for approval is
durable database state, but this event stream currently records only completed
and blocked terminal attempts. Dashboards and denominators must not invent a
paused signal.

---

## 2. Query parameters

Record these values from the deployment before running a preview or production
review:

| Parameter | Example | Source |
|---|---|---|
| `ENV` | `preview` | Sentry/Vercel deployment environment |
| `RELEASE` | commit SHA or configured Sentry release | Sentry release shown for the deployment |
| `DEPLOYMENT_ID` | Vercel deployment id | Vercel deployment details |
| `START_UTC` | `2026-07-16T18:00:00Z` | deployment start |
| `END_UTC` | `2026-07-16T19:00:00Z` | end of validation window |

Do not compare an unbounded “last 24 hours” window with a single deployment;
scope every release gate to these values.

---

## 3. Sentry queries

These are Sentry Logs queries when JSON fields are parsed as log attributes.
Always select environment `ENV`, release `RELEASE`, and the
`START_UTC..END_UTC` time range in the UI:

```text
event:approval.decided
event:approval.executed
event:approval.step_up_verified
event:routine.run.completed
event:routine.run.blocked
event:observability.event.rejected
```

If the Sentry log integration stores the JSON line only as a message, use the
equivalent literal searches:

```text
message:"\"event\":\"approval.decided\""
message:"\"event\":\"approval.executed\""
message:"\"event\":\"approval.step_up_verified\""
message:"\"event\":\"routine.run.completed\""
message:"\"event\":\"routine.run.blocked\""
message:"\"event\":\"observability.event.rejected\""
```

For the post-preview error gate, Sentry Issues must be filtered to environment
`ENV`, release `RELEASE`, and first seen in `START_UTC..END_UTC`. The gate is:

1. no new unresolved 5xx/unexpected issue attributable to the release;
2. zero `observability.event.rejected` records;
3. each manually exercised happy path has its expected event and `requestId`;
4. any blocked routine has a matching Sentry exception/breadcrumb by
   `requestId` or `runId`, without private content.

If the release or log integration is missing, this gate is **blocked**, not
silently passed.

---

## 4. Vercel queries

In Vercel Logs, first scope to `DEPLOYMENT_ID` and
`START_UTC..END_UTC`. Search for these exact JSON fragments:

```text
"event":"approval.decided"
"event":"approval.executed"
"event":"approval.step_up_verified"
"event":"routine.run.completed"
"event":"routine.run.blocked"
"event":"observability.event.rejected"
```

For a single workflow, copy its UUID `requestId` from the first record and query:

```text
"requestId":"<uuid>"
```

For a routine across retries, query:

```text
"runId":"<uuid>"
```

The Vercel gate is zero rejected events and no uncorrelated 5xx for the tested
request/run. If structured logs are unavailable for the deployment, record the
missing drain/access as an external production blocker.

---

## 5. Dashboard widgets

Create one dashboard named **Axis — Operate Loop** after Sentry Logs or the
Vercel drain is verified.

### Approval reliability

- Decision volume: `event:approval.decided`, count grouped by `decision`.
- Decision latency: `event:approval.decided`, p50/p95 of
  `decisionLatencyMs`.
- Approved-to-executed conversion: count `approval.executed` divided by count
  of `approval.decided` where `decision:approved`, using the same time window.
- Approve-to-execute window: `event:approval.executed`, p50/p95 of
  `executeLatencyMs`.
- Step-up share: `approval.executed` where `stepUpRequired:true` divided by all
  `approval.executed`.

Decision-event latency cannot detect approvals that remain pending forever.
Queue-stall monitoring requires a separate owner-scoped database metric over
pending `approvals.created_at`; do not label decision latency as queue depth.

### Routine reliability

- Outcomes: counts of `routine.run.completed` and `routine.run.blocked`,
  grouped by `routine`.
- Error budget:
  `blocked / (completed + blocked)` for the same routine and time window.
- Failure backlog: `routine.run.blocked`, grouped by `errorCode`, then `stage`.
- Resume health: blocked/completed counts filtered by
  `resumedFromApproval:true`.
- Contract health: count `observability.event.rejected`; expected value is zero.

### Integration and cost health

- Integration errors come from Sentry exceptions tagged with normalized
  `provider`, `transport`, `operation`, `status`, and `code`.
- Routine AI cost comes from owner-scoped persisted
  `routine_runs.actual_cost_usd`, not this log stream. Do not copy cost values
  into events.

---

## 6. Minimum alerts

| Alert | Deterministic condition | Window |
|---|---|---|
| Event contract rejected | count `event:observability.event.rejected` > 0 | 5m |
| Routine error budget | `blocked / (completed + blocked) > 5%` and total attempts ≥ 5, grouped by routine | 1h |
| Routine hard outage | blocked ≥ 3 and completed = 0, grouped by routine | 15m |
| Approval execution gap | approved decisions ≥ 5 and executed / approved < 80% | 24h |
| Step-up abuse signal | Sentry transaction count for normalized step-up route with HTTP 400 or 429 ≥ 10 | 10m |
| Integration outage | Sentry exceptions with `code:UPSTREAM_UNAVAILABLE` > 10, grouped by provider | 10m |

An approval queue-stall alert and AI cost-jump alert require database-derived
metrics not emitted by the current catalogue. They remain external monitoring
work; they must not be represented by fabricated log queries.

---

## 7. External production gate

The code and query specification are repository-verifiable. Production
readiness still requires an operator with Sentry/Vercel access to:

1. confirm structured JSON attribute parsing (or use literal message queries);
2. create the dashboard and alerts in §§5–6;
3. run the release-scoped post-preview checks in §§3–4;
4. record links/screenshots or API results in the PR;
5. assign an owner for the pending database-derived queue/cost monitors.

Until those steps are recorded, Phase 13 observability is implemented locally
but the hosted observability gate remains open.

### PR #195 observed access result

The exact release for commit
`dad075921e11fff36c1996bd14d18f95666d3e5a` is registered in Sentry. Release
metadata reports `newGroups=2`, but the
release/environment Issues query
`environment:preview release:<sha> firstSeen:>START_UTC` returned HTTP 403 with
the available token. That result is an access failure, not evidence of zero
regressions. The repository owner or Sentry administrator must run and record
the query for the final preview SHA, then create/verify the dashboard and alerts
above. Until that evidence exists, production merge remains blocked.
