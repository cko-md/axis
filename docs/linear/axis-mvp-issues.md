# AXIS MVP — Linear-ready Implementation Plan

> Source of truth for turning the platform audit (`docs/audits/axis-platform-audit.md`) into executable Linear work.
> Repo: `cko-md/axis` · Next.js 15 App Router · Supabase · Composio/Make · Vercel · Sentry · Tembo.
> Every issue below is scoped to **one focused Claude coding session** → one branch → one PR → one Vercel preview → Sentry-monitored.
> Generated 2026-06-28 from commit `176bd85`.

---

## How to use this document

Each `#`-level heading is a Linear issue, ready to paste. Copy the **Claude implementation prompt** block into a fresh Claude Code session to execute that issue. Do not let Claude expand scope beyond the issue's "Files likely to change" + "What NOT to change."

### Toolchain contract (applies to every issue)
- **GitHub:** branch from `main` using the suggested branch name; open a PR with the suggested title; PR body must include the manual-test evidence + Vercel preview URL. Linear auto-links via branch name `…/AX-<n>-…` (use the Linear issue id once created).
- **Vercel:** every PR gets a preview deploy. "Done" requires the preview build to succeed and the happy + error paths to be exercised on the preview URL.
- **Supabase/Tembo:** any schema change is a numbered migration in `supabase/migrations` (see DATA-1). State explicitly in the PR whether a migration is required and whether it was applied. **Do not run `supabase db push` against prod without confirming migration ordering (audit A4).**
- **Sentry:** every provider/network/DB failure path must be captured with tagged context. "Done" requires no *new* Sentry error for the tested happy path.
- **Claude/Human split:** `Claude` = mechanical/well-scoped; `Review-needed` = Claude drafts, human reviews before merge (security, migrations, money/auth); `Human` = decision or external-account action Claude can't do (e.g. connecting a live provider, setting env vars in Vercel).

### Label taxonomy
`area:mail` `area:calendar` `area:agenda` `area:dispatch` `area:integrations` `area:data` `area:infra` `area:ai` `area:ux` ·
`type:bug` `type:feature` `type:refactor` `type:chore` `type:test` ·
`provider:composio` `provider:gmail` `provider:outlook` `provider:plaid` `provider:strava` ·
`migration` `security` `rls` `latency` `observability` `cache` ·
`claude-ready` `review-needed` `needs-human` `feature-flag`

### Status convention
`Backlog` (blocked/future) · `Todo` (ready for a Claude session) · `In Progress` · `In Review` (PR open) · `Done`.

---

## Initiative: Ship a production-trustworthy AXIS

**Outcome:** every surfaced feature either works end-to-end and survives refresh, or is honestly gated. No silent failures, no dead-end integrations, cache-first reads on the critical path, and an observable deploy pipeline.

**Definition of MVP done:** Mail is a complete read+act slice across both provider paths; integrations report health and can be reconnected; the data layer is deterministic (clean migrations, typed client, sync-state model); the app is observable (Sentry) and safe to deploy (env validation, smoke tests).

### Projects
1. **Mail Production Slice** — read/act parity across Composio + direct OAuth; cache-first; observable. *(MAIL-1…10)*
2. **Calendar + Agenda Slice** — calendar read/write parity + Agenda consumption. *(CAL-* backlog)*
3. **Integration Adapter Refactor** — registry, normalized accounts, health + structured errors, sync-state. *(INT-1…7)*
4. **Dispatch + Command Center** — routing spine hardening + Console drill-ins. *(DISP-* backlog)*
5. **Latency + Observability** — cache-first reads, Sentry/metrics, pagination. *(OBS-* backlog; MAIL-8/9 contribute)*
6. **Production Hardening** — env validation, deploy checklist, smoke tests, graceful degradation. *(PROD-1…7)*
7. **UX / Design System** — states, detail views, design tokens consistency. *(UX-* backlog)*
8. **Data Layer + Sync Architecture** — migrations audit, cache/sync/id-mapping tables, RLS, Tembo role. *(DATA-1…8)*
9. **AI Workflow Layer** — router hardening, cron wiring, AI insight surfaces. *(AI-* backlog)*
10. **Integration Health + Control Room** — health surface, reconnect flow, health-device decision. *(INT-3/4/5 contribute; IHC-* backlog)*

### Milestones
- **M0 — Mail unblocked** (P0): MAIL-1, MAIL-2, MAIL-3. The known detail bug is dead.
- **M1 — Data + integration spine** (P0): DATA-1…6, INT-1, INT-2, INT-6. Deterministic schema + adapter contract.
- **M2 — Mail complete slice** (P0/P1): MAIL-4…10. Parity, actions, cache, pagination, observability.
- **M3 — Integration health** (P1): INT-3,4,5,7; IHC backlog. Reconnect + sync-state live.
- **M4 — Production-ready** (P1): PROD-1…7. Env validation, smoke tests, graceful degradation, deploy checklist.
- **M5 — Latency + UX polish** (P2): OBS/UX/DISP/CAL/AI backlogs.

### Suggested execution order (dependency-aware)
`DATA-1 → DATA-7/8 (Tembo) → MAIL-1 → MAIL-2 → MAIL-3 → INT-1 → INT-2 → INT-6 → MAIL-4 → MAIL-5 → MAIL-6 → DATA-3/4/5 → MAIL-8 → MAIL-7 → INT-7 → INT-3 → INT-4 → INT-5 → MAIL-9 → MAIL-10 → PROD-1…7`.

---
---

# PROJECT 1 — Mail Production Slice

The audit's first concrete bug: **Composio mailbox messages render in the inbox list but do not open into readable detail.** Root cause (verified): `GET /api/mail/message/[id]` only calls `getGmailMessage`/`getOutlookMessage` (direct-OAuth token readers); there is no Composio branch and `lib/mail/composio.ts` has no single-message fetcher. The client `openMessage` also never passes the account's `via`/`connectedAccountId`, so the route cannot tell a Composio account apart from a direct one. For a Composio account there are no direct tokens → reader returns `null` → route returns 404 → `MessagePanel` never populates.

MAIL-1/2 fix this for Gmail then Outlook; MAIL-3 makes the failure visible; MAIL-4 extracts the contract; MAIL-5/6 add parity actions; MAIL-7/8 add pagination + cache; MAIL-9/10 add observability + the repeatable preview checklist.

---

# [P0] Mail: Composio Gmail messages open into readable detail

## Linear metadata
- **Project:** Mail Production Slice
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:mail` `type:bug` `provider:composio` `provider:gmail` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** M
- **Dependencies:** none (can start immediately; DATA-1 recommended but not blocking)
- **Blocks / blocked by:** Blocks MAIL-2, MAIL-4. Blocked by: none.
- **Suggested branch:** `claude/mail-composio-gmail-detail`
- **Suggested PR title:** `fix(mail): open Composio Gmail messages into MessagePanel`
- **Suggested commit message:** `fix(mail): read Composio Gmail message detail via adapter`

## Problem
Clicking a Composio-connected Gmail inbox row does not open the message; the detail panel stays empty / errors. Direct-OAuth Gmail works.

## Current behavior
`openMessage` (`MailModule.tsx:272`) fetches `/api/mail/message/{id}?provider=gmail&email=…` with **no `via`**. The route (`api/mail/message/[id]/route.ts`) calls `getGmailMessage(user.id, email, id)` which reads direct OAuth tokens from `mail_connections`. A Composio account has no such tokens → `null` → HTTP 404. `lib/mail/composio.ts` exposes `listComposioInbox`/`sendComposioMail` but **no** `getComposioMessage`.

## Expected behavior
Clicking a Composio Gmail row opens `MessagePanel` showing subject, sender, date, and rendered body (HTML or plain). The route resolves the account → detects `via: "composio"` → fetches the single message through Composio and returns the same `MailMessageFull` shape direct OAuth returns.

## User workflow
Log in → Control Room/Mail: connect Gmail via Composio → open Mail → click a Gmail message → read it in the panel → close → list still intact.

## Why this matters
Mail is a core daily module and the flagship Composio integration. A read-only inbox you can't read is the single most visible broken path in the app.

## Affected modules/pages
`/mail` (`MailModule`, `MessagePanel`). No cross-module side effects, but it sets the contract MAIL-2 (Outlook) reuses.

## Cross-module implications
Establishes how the detail route disambiguates provider path by account `via` — INT-1/INT-2 will later own this resolution centrally.

## Technical scope
### Files to inspect
- `src/app/api/mail/message/[id]/route.ts`
- `src/lib/mail/composio.ts` (list/send patterns, `executeTool`, tool slugs)
- `src/lib/mail/gmail.ts` (`MailMessageFull` shape, `getGmailMessage`, body decode/HTML handling)
- `src/lib/mail/tokens.ts` (`listMailAccounts` → returns `via`, `connectedAccountId`)
- `src/components/mail/MailModule.tsx` (`openMessage`), `src/components/mail/MessagePanel.tsx`
- `src/lib/integrations/composio.ts` (`executeTool` signature)

### Files likely to change
- `src/lib/mail/composio.ts` — add `getComposioMessage(toolkit, connectedAccountId, userId, messageId, accountEmail): Promise<MailMessageFull | null>` (Gmail path only required here; Outlook stub returns `null` until MAIL-2).
- `src/app/api/mail/message/[id]/route.ts` — resolve the account via `listMailAccounts(user.id)`, branch on `via`.

### API routes
`GET /api/mail/message/[id]` (modify). No new route.

### Database impact
None. Reads `composio_connections` indirectly via `listMailAccounts`. No migration.

### Integration impact
Composio: use the Gmail single-message tool (confirm exact slug via Composio tools API — likely `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` or `GMAIL_GET_MESSAGE`; the inbox uses `GMAIL_FETCH_EMAILS`). Map the response body defensively (payload/parts/base64url **and** Composio flattened `messageText`/`messageHtml`) exactly like `normalizeGmailMessage` does for list rows.

### Observability
On Composio tool failure or unmapped body, capture a Sentry event tagged `area=mail provider=gmail via=composio op=get_message` with `messageId` (not body). Route returns 502 with `{ error }` on provider failure, 404 only on genuine not-found.

## Claude implementation prompt
Paste this into Claude:

```txt
You are fixing a P0 bug in the AXIS repo (Next.js 15 App Router): Composio Gmail messages render in the inbox list but do not open into detail. Work ONLY on the Composio Gmail read-detail path.

1. INSPECT FIRST (read, do not edit yet):
   - src/app/api/mail/message/[id]/route.ts
   - src/lib/mail/composio.ts  (listComposioInbox, sendComposioMail, normalizeGmailMessage, LIST_TOOL)
   - src/lib/mail/gmail.ts  (the MailMessageFull type and getGmailMessage body decode/HTML logic — your Composio function MUST return the identical shape)
   - src/lib/mail/tokens.ts  (listMailAccounts — note it returns via and connectedAccountId per account)
   - src/lib/integrations/composio.ts (executeTool signature)
   - src/components/mail/MailModule.tsx openMessage(), src/components/mail/MessagePanel.tsx

2. EXPLAIN BEFORE CODING (write 4-6 sentences): the exact data flow today, why a Composio account 404s, the MailMessageFull fields you must produce, and which Composio Gmail tool slug you'll use (verify the slug — search Composio's tools; do not invent it).

3. IMPLEMENT:
   a. Add getComposioMessage(toolkit: "gmail"|"outlook", connectedAccountId, userId, messageId, accountEmail) to src/lib/mail/composio.ts. Implement the gmail branch only; for outlook return null with a TODO referencing MAIL-2. Call executeTool with the verified single-message slug. Map subject/from/date from headers, body via payload parts (base64url decode, prefer text/html else text/plain, set bodyIsHtml) AND fall back to Composio flattened fields (messageHtml/messageText). Return null only if the message truly isn't found; throw on provider error.
   b. In api/mail/message/[id]/route.ts: after auth, call listMailAccounts(user.id), find the account matching provider+email, read its `via` and connectedAccountId. If via === "composio", call getComposioMessage(...). Else keep the existing direct path. If the provider call throws, return NextResponse.json({error}, {status:502}); keep 404 for not-found.
   c. Capture provider failures to Sentry with tags { area:"mail", provider, via, op:"get_message" } and messageId in context (NEVER the body).

4. DO NOT: change the inbox list route, the send route, the direct-OAuth gmail.ts logic, MessagePanel rendering, or any Outlook behavior. Do not refactor listMailAccounts. Do not add a cache table (that's MAIL-8).

5. ACCEPTANCE CRITERIA: see issue. Run `npx tsc --noEmit` clean.

6. MANUAL TEST CHECKLIST: perform it and paste results in your final message.

7. REGRESSION RISKS: direct-OAuth Gmail detail must still work; Outlook rows must not change behavior; sanitize HTML before render (confirm MessagePanel already uses DOMPurify — it imports isomorphic-dompurify; do not weaken it).

8. FINAL RESPONSE FORMAT: (a) the data-flow explanation, (b) unified summary of edits per file, (c) completed manual checklist with pass/fail, (d) tsc result, (e) any follow-ups (e.g., body-mapping uncertainty) as bullet notes for MAIL-4.
```

## Acceptance criteria
- [ ] Clicking a Composio Gmail inbox row opens `MessagePanel` with subject, sender, date, and rendered body.
- [ ] Message body HTML is sanitized (DOMPurify) before render; plain-text bodies render readably.
- [ ] If the Composio provider request fails, the API returns 502 and the UI shows a visible error (MAIL-3 deepens this; at minimum no infinite spinner).
- [ ] The route verifies the account (provider+email) belongs to the authenticated user before fetching.
- [ ] Direct-OAuth Gmail detail still opens correctly.
- [ ] `npx tsc --noEmit` passes with no new errors.
- [ ] No new Sentry error for the happy path; provider-failure path emits a tagged Sentry event.

## Manual test checklist
- [ ] 1. `npm run dev`.
- [ ] 2. Log in.
- [ ] 3. Connect a Gmail account via Composio (Control Room → Integrations) if not already.
- [ ] 4. Open `/mail`.
- [ ] 5. Happy path: click a Composio Gmail row → panel shows subject/sender/date/body.
- [ ] 6. Error path: temporarily point the slug to a bad value (or disconnect mid-session) → UI shows error, no infinite spinner; restore.
- [ ] 7. Refresh `/mail` → list persists; re-open a message works.
- [ ] 8. Confirm the same on the Vercel preview URL.
- [ ] 9. Confirm no new Sentry error for step 5.
- [ ] 10. Confirm direct-OAuth Gmail (if connected) and Outlook rows still behave as before.

## Deployment validation
- [ ] Vercel preview deploy succeeds.
- [ ] Sentry shows no new error for the tested happy path.
- [ ] Supabase/Tembo migrations: **not required** (state this in the PR).
- [ ] GitHub PR description includes the completed checklist + preview URL + a screenshot of an opened Composio Gmail message.

---

# [P0] Mail: Composio Outlook messages open into readable detail

## Linear metadata
- **Project:** Mail Production Slice
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:mail` `type:bug` `provider:composio` `provider:outlook` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** MAIL-1 (reuses `getComposioMessage` scaffold + route branch)
- **Blocks / blocked by:** Blocked by MAIL-1. Blocks MAIL-4.
- **Suggested branch:** `claude/mail-composio-outlook-detail`
- **Suggested PR title:** `fix(mail): open Composio Outlook messages into MessagePanel`
- **Suggested commit message:** `fix(mail): implement Composio Outlook message detail`

## Problem
Same class of bug as MAIL-1, for Outlook: Composio Outlook rows don't open into detail.

## Current behavior
After MAIL-1, `getComposioMessage` returns `null` for `toolkit==="outlook"`; the route 404s for Composio Outlook accounts.

## Expected behavior
Composio Outlook rows open into `MessagePanel` with subject/sender/date/body, matching `MailMessageFull` (`getOutlookMessage` shape).

## User workflow
Log in → connect Outlook via Composio → `/mail` → click an Outlook row → read.

## Why this matters
Provider parity: Mail must not be "Gmail-only" through Composio.

## Affected modules/pages
`/mail`.

## Cross-module implications
Completes the Composio read-detail contract both directions; unblocks the MAIL-4 extraction.

## Technical scope
### Files to inspect
- `src/lib/mail/composio.ts` (the `getComposioMessage` outlook stub from MAIL-1, `normalizeOutlookMessage`)
- `src/lib/mail/outlook.ts` (`getOutlookMessage`, body/HTML fields, `MailMessageFull`)
### Files likely to change
- `src/lib/mail/composio.ts` — implement the outlook branch of `getComposioMessage`.
### API routes
`GET /api/mail/message/[id]` (no change if MAIL-1 already branches on `via`).
### Database impact
None. No migration.
### Integration impact
Composio Outlook single-message tool (verify slug; list uses `OUTLOOK_OUTLOOK_LIST_MESSAGES`). Map `subject`, `from.emailAddress`, `receivedDateTime`, and `body.content`/`body.contentType` (HTML vs text).
### Observability
Sentry tag `provider=outlook via=composio op=get_message` on failure.

## Claude implementation prompt
Paste this into Claude:

```txt
Implement the Outlook branch of getComposioMessage in the AXIS repo (depends on MAIL-1 already merged).

1. INSPECT: src/lib/mail/composio.ts (getComposioMessage outlook stub, normalizeOutlookMessage), src/lib/mail/outlook.ts (getOutlookMessage + MailMessageFull body/contentType handling), src/app/api/mail/message/[id]/route.ts.
2. EXPLAIN: which Composio Outlook single-message tool slug you'll use (verify it; the list tool is OUTLOOK_OUTLOOK_LIST_MESSAGES), and how Outlook returns body (body.content + body.contentType: "html"|"text").
3. IMPLEMENT the outlook branch: executeTool with the verified slug + message id; map subject, from (name <address>), receivedDateTime → date, body.content → body with bodyIsHtml = contentType==="html". Return null only on true not-found; throw on provider error.
4. DO NOT touch the gmail branch, the direct outlook.ts path, the route (already branches on via), or MessagePanel.
5. ACCEPTANCE: Composio Outlook rows open with subject/sender/date/body; direct + Gmail unaffected; tsc clean.
6. MANUAL TEST CHECKLIST: run it, paste results.
7. REGRESSION RISKS: don't regress Gmail; sanitize HTML on render (MessagePanel/DOMPurify).
8. FINAL RESPONSE: explanation, per-file edits, checklist results, tsc result.
```

## Acceptance criteria
- [ ] Clicking a Composio Outlook row opens `MessagePanel` with subject, sender, date, body.
- [ ] Outlook HTML bodies render sanitized; plain-text renders readably.
- [ ] Provider failure → 502 + visible error (no infinite spinner).
- [ ] Account ownership verified server-side.
- [ ] Composio Gmail + direct-OAuth paths still work.
- [ ] `npx tsc --noEmit` clean; no new Sentry error on happy path.

## Manual test checklist
- [ ] 1. `npm run dev`. 2. Log in. 3. Connect Outlook via Composio. 4. Open `/mail`. 5. Click an Outlook row → reads. 6. Force a provider error → visible error. 7. Refresh → persists. 8. Vercel preview. 9. No new Sentry error. 10. Gmail + direct paths still work.

## Deployment validation
- [ ] Vercel preview deploy succeeds.
- [ ] Sentry shows no new error for tested flow.
- [ ] Supabase/Tembo migrations: not required (state in PR).
- [ ] PR description includes checklist + preview URL + screenshot.

---

# [P0] Mail: visible error + retry state when message detail fetch fails

## Linear metadata
- **Project:** Mail Production Slice
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:mail` `area:ux` `type:bug` `observability` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** MAIL-1
- **Blocks / blocked by:** Blocked by MAIL-1. Soft-blocks MAIL-9.
- **Suggested branch:** `claude/mail-detail-error-state`
- **Suggested PR title:** `feat(mail): visible error + retry for message detail failures`
- **Suggested commit message:** `feat(mail): surface message-detail fetch errors with retry`

## Problem
When detail fetch fails (404/502/network), the panel currently fails silently or spins. Violates "no silent failures."

## Current behavior
`openMessage` sets some loading state; on non-OK responses the panel does not clearly show an actionable error.

## Expected behavior
Failed detail fetch shows an inline error in `MessagePanel` (e.g. "Couldn't load this message") with a **Retry** button and a toast; retry re-runs the fetch. Distinguishes 404 ("message no longer available") from 502/network ("provider unavailable — retry").

## User workflow
Click a row → provider hiccups → see error + Retry → click Retry → message loads.

## Why this matters
Direct audit finding U2/L2: per-account and per-message mail failures are invisible today.

## Affected modules/pages
`/mail` (`MailModule.openMessage`, `MessagePanel`, `ui/Toast`).

## Cross-module implications
Sets the error-UX pattern reused by Calendar + Dispatch detail fetches.

## Technical scope
### Files to inspect
`src/components/mail/MailModule.tsx`, `src/components/mail/MessagePanel.tsx`, `src/components/ui/Toast.tsx`.
### Files likely to change
`MailModule.tsx` (track `detailError` + `detailLoading` + status code), `MessagePanel.tsx` (render error + Retry).
### API routes
None (consumes MAIL-1's status codes).
### Database impact
None. No migration.
### Integration impact
None directly.
### Observability
Emit Sentry breadcrumb on retry; the actual provider error is captured in MAIL-1/9.

## Claude implementation prompt
Paste this into Claude:

```txt
Add a visible error + retry state to AXIS Mail message detail (depends on MAIL-1).
1. INSPECT: src/components/mail/MailModule.tsx (openMessage, selected message state), src/components/mail/MessagePanel.tsx, src/components/ui/Toast.tsx (toast signature).
2. EXPLAIN: current loading/empty/error handling in MessagePanel and what's missing.
3. IMPLEMENT: in openMessage, capture res.status and parsed error; set state { loading, error: {status, message} }. In MessagePanel, when error is set, render an inline error block ("Couldn't load this message" for 502/network with Retry; "This message is no longer available" for 404, no retry) and call toast(message, "error", "Mail"). Wire Retry to re-invoke openMessage(msg). Keep the existing success render unchanged.
4. DO NOT change the API route, adapters, or list rendering. No new deps.
5. ACCEPTANCE: see issue; tsc clean.
6. MANUAL TEST CHECKLIST: include forcing 404 and 502.
7. REGRESSION RISKS: don't break the normal open flow or leave stale errors when switching messages (clear error on new selection).
8. FINAL RESPONSE: explanation, per-file edits, checklist results, tsc result.
```

## Acceptance criteria
- [ ] A failed detail fetch renders a visible inline error in `MessagePanel` + a toast.
- [ ] 502/network errors show a **Retry** that re-fetches and can succeed; 404 shows a non-retry "no longer available" message.
- [ ] Selecting a different message clears the previous error.
- [ ] No infinite spinners.
- [ ] `npx tsc --noEmit` clean; happy path emits no Sentry error.

## Manual test checklist
- [ ] 1. `npm run dev`. 2. Log in. 3. Ensure ≥1 mail account. 4. `/mail`. 5. Open a message (happy). 6a. Force 502 (bad slug) → error + Retry works after restore. 6b. Force 404 → "no longer available". 7. Switch messages → error clears. 8. Vercel preview. 9. No new Sentry error on happy path. 10. List + send unaffected.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required (state in PR). [ ] PR includes checklist + preview URL + screenshots of both error variants.

---

# [P0] Mail: adapter contract for direct OAuth and Composio mail providers

## Linear metadata
- **Project:** Mail Production Slice → feeds Integration Adapter Refactor
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:mail` `area:integrations` `type:refactor` `review-needed`
- **Suggested assignee type:** Review-needed (Claude drafts; human reviews the contract)
- **Estimated complexity:** M
- **Dependencies:** MAIL-1, MAIL-2
- **Blocks / blocked by:** Blocks MAIL-5, MAIL-6, INT-1. Blocked by MAIL-1/2.
- **Suggested branch:** `claude/mail-adapter-contract`
- **Suggested PR title:** `refactor(mail): unify provider dispatch behind a MailAdapter contract`
- **Suggested commit message:** `refactor(mail): introduce MailAdapter interface + lib/mail/index dispatch`

## Problem
Provider branching is smeared across route handlers (audit A2): `inbox`, `message/[id]`, `send`, `disconnect` each re-implement "is this composio or direct?". This duplication is where parity bugs (MAIL-1/2) come from.

## Current behavior
Routes import `gmail.ts`/`outlook.ts`/`composio.ts` directly and branch inline; `listMailAccounts` already returns a unified account list with `via`.

## Expected behavior
A single `lib/mail/index.ts` exposes `listInbox(userId, opts)`, `getMessage(userId, ref)`, `sendMail(userId, msg)`, `disconnect(userId, account)` that internally select the adapter by account `via`. Routes become thin pass-throughs with auth + validation only. No behavior change — pure refactor guarded by the MAIL-1/2/3 tests/flows.

## User workflow
Unchanged (refactor). Validation = all existing mail flows still work.

## Why this matters
Removes the structural cause of provider drift; prerequisite for clean MAIL-5/6 and INT-1.

## Affected modules/pages
`/mail` (no UI change).

## Cross-module implications
Defines the `MailAdapter` shape that INT-1's registry generalizes to calendar/contacts.

## Technical scope
### Files to inspect
`src/app/api/mail/{inbox,message/[id],send,status,disconnect}/route.ts`, `src/lib/mail/{gmail,outlook,composio,tokens}.ts`.
### Files likely to change
- New `src/lib/mail/index.ts` (dispatch + `MailAdapter` type).
- Slim the 5 route handlers to call it.
- No change to adapter internals beyond what's needed to conform.
### API routes
All `/api/mail/*` (slimmed, same contracts/response shapes).
### Database impact
None. No migration.
### Integration impact
Both Composio + direct continue to work; the dispatch centralizes `via` selection.
### Observability
Centralize the Sentry tagging (`area:mail op:<list|get|send|disconnect> provider via`) in `index.ts`.

## Claude implementation prompt
Paste this into Claude:

```txt
Refactor AXIS mail provider dispatch behind one contract. This is a NO-BEHAVIOR-CHANGE refactor; depends on MAIL-1/2/3.
1. INSPECT all of: src/app/api/mail/{inbox,message/[id],send,status,disconnect}/route.ts and src/lib/mail/{gmail,outlook,composio,tokens}.ts. Note response shapes returned to the client EXACTLY.
2. EXPLAIN: a table of (operation × provider path) and where each currently lives.
3. IMPLEMENT: create src/lib/mail/index.ts exporting a MailAdapter type and functions listInbox(userId, {account?, pageToken?, skip?}), getMessage(userId, {provider, email, id}), sendMail(userId, {...}), disconnect(userId, account). Internally resolve accounts via listMailAccounts and dispatch by via (composio vs direct). Move the existing per-provider calls here unchanged. Centralize Sentry tagging here. Then rewrite the 5 route handlers to: auth + param validation + call index.ts + return the SAME JSON shape as before.
4. DO NOT change response JSON shapes, adapter internals' behavior, or any client component. Do not add caching/pagination changes (separate issues).
5. ACCEPTANCE: every mail flow behaves identically; routes contain no provider names; tsc clean.
6. MANUAL TEST CHECKLIST: exercise list/open/send/disconnect for each connected provider path.
7. REGRESSION RISKS: subtle response-shape drift; per-account allSettled behavior in inbox must be preserved.
8. FINAL RESPONSE: the operation×provider table, new index.ts API, per-route diffs summary, checklist results, tsc result.
```

## Acceptance criteria
- [ ] `src/lib/mail/index.ts` exists with `MailAdapter` + `listInbox/getMessage/sendMail/disconnect`.
- [ ] No `/api/mail/*` route references provider names directly.
- [ ] All mail flows (list, open Gmail+Outlook, Composio+direct, send, disconnect) behave identically to pre-refactor.
- [ ] Response JSON shapes unchanged (diff the network responses).
- [ ] `npx tsc --noEmit` clean; no new Sentry errors on happy paths.

## Manual test checklist
- [ ] 1–4 standard. 5. List loads; open Gmail (Composio+direct) and Outlook; send a test mail; disconnect+reconnect one account. 6. Force one provider error → still surfaced (MAIL-3). 7. Refresh persists. 8. Vercel preview. 9. No new Sentry error. 10. Status route + account filter chips still work.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required (state in PR). [ ] PR shows before/after network response parity.

---

# [P1] Mail: reply / send parity across direct OAuth and Composio

## Linear metadata
- **Project:** Mail Production Slice
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `type:feature` `provider:composio` `review-needed`
- **Suggested assignee type:** Review-needed
- **Estimated complexity:** M
- **Dependencies:** MAIL-4
- **Blocks / blocked by:** Blocked by MAIL-4.
- **Suggested branch:** `claude/mail-reply-send-parity`
- **Suggested PR title:** `feat(mail): reply + send parity across Composio and direct OAuth`
- **Suggested commit message:** `feat(mail): add reply with threading across providers`

## Problem
Compose/send exists, but **reply** (in-thread, with quoting + recipients prefilled) is not at parity; send behavior differs subtly between Composio and direct.

## Current behavior
`ComposeModal` + `/api/mail/send` support new sends; `sendComposioMail`/direct send have different arg shapes (`recipient_email` vs `to_email`). No reply-from-detail with `In-Reply-To`/`threadId`.

## Expected behavior
From an open message, **Reply** opens `ComposeModal` prefilled (to = sender, subject = "Re: …", quoted body) and sends through the same provider the message came from, threaded where the provider supports it.

## User workflow
Open message → Reply → edit → Send → success toast → reply appears in thread on next sync.

## Why this matters
A mail client that can't reply is a viewer, not a slice.

## Affected modules/pages
`/mail` (`MessagePanel`, `ComposeModal`, send path via `lib/mail/index.ts`).

## Cross-module implications
None.

## Technical scope
### Files to inspect
`src/components/mail/{MessagePanel,ComposeModal}.tsx`, `src/lib/mail/index.ts` (post-MAIL-4), `src/lib/mail/composio.ts` (`sendComposioMail`), `src/app/api/mail/send/route.ts`.
### Files likely to change
`MessagePanel.tsx` (Reply button + prefill), `ComposeModal.tsx` (accept reply context), `lib/mail/index.ts`/`composio.ts` (threading args).
### API routes
`POST /api/mail/send` (extend with optional `inReplyToId`/`threadId`).
### Database impact
None unless cache exists (MAIL-8) — then mark thread dirty. No migration here.
### Integration impact
Composio Gmail/Outlook send tools may support thread/reply params — verify slugs/args; degrade to plain send (still threaded by subject) if not.
### Observability
Sentry tag `op:send reply:true provider via` on failure.

## Claude implementation prompt
Paste this into Claude:

```txt
Add reply parity to AXIS Mail (depends on MAIL-4's lib/mail/index.ts).
1. INSPECT: MessagePanel.tsx, ComposeModal.tsx, lib/mail/index.ts (sendMail), lib/mail/composio.ts (sendComposioMail args), api/mail/send/route.ts. Verify whether the Composio Gmail/Outlook send tools accept a thread/in-reply-to argument (search Composio tools; do not invent).
2. EXPLAIN: how send differs across providers today and what threading each supports.
3. IMPLEMENT: add a Reply button in MessagePanel that opens ComposeModal with { to: sender, subject: "Re:"+subject (no double Re:), quotedBody, replyContext: {provider, email, threadId, messageId} }. Extend sendMail/route to accept optional inReplyToId/threadId and pass to the provider tool when supported; otherwise plain send. Keep new-compose working.
4. DO NOT change list/detail read paths or unrelated send behavior; no new deps.
5. ACCEPTANCE: reply prefilled correctly; sends via the originating provider; success/error feedback; both provider paths work.
6. MANUAL TEST: reply on Composio Gmail and (if connected) Outlook; verify the reply lands.
7. REGRESSION RISKS: double "Re:", wrong recipient, sending via wrong account.
8. FINAL RESPONSE: explanation, per-file edits, checklist, tsc result, note any provider lacking native threading.
```

## Acceptance criteria
- [ ] Reply from an open message prefills to/subject/quoted body and sends via the same provider+account.
- [ ] Subject is not double-prefixed ("Re: Re:").
- [ ] Send success shows a toast; failure shows a visible error (MAIL-3 pattern).
- [ ] Works for Composio Gmail and Outlook (and direct if connected).
- [ ] `npx tsc --noEmit` clean; happy path no new Sentry error.

## Manual test checklist
- [ ] 1–4 standard (connect a provider). 5. Open a message → Reply → send → confirm delivery in the real mailbox. 6. Force send failure → visible error. 7. Refresh → no duplicate sends. 8. Vercel preview. 9. No new Sentry error. 10. New-compose still works.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required (state in PR). [ ] PR shows a real delivered reply (redact PII).

---

# [P1] Mail: archive / delete / mark-read actions

## Linear metadata
- **Project:** Mail Production Slice
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `type:feature` `provider:composio` `review-needed`
- **Suggested assignee type:** Review-needed (destructive actions)
- **Estimated complexity:** M
- **Dependencies:** MAIL-4
- **Blocks / blocked by:** Blocked by MAIL-4. Pairs with MAIL-8 (cache invalidation).
- **Suggested branch:** `claude/mail-message-actions`
- **Suggested PR title:** `feat(mail): archive, delete, and mark-read actions`
- **Suggested commit message:** `feat(mail): add archive/delete/mark-read across providers`

## Problem
Audit U2: no archive/delete/mark-read; the inbox is read-only.

## Current behavior
No mutate-message actions exist on any provider path.

## Expected behavior
From a row or open message: **Mark read/unread**, **Archive**, **Delete** (with confirm). Optimistic UI update + provider call; on failure, revert + visible error.

## User workflow
Select message → action → list/panel updates immediately → persists on refresh.

## Why this matters
Triage is the point of a mail slice.

## Affected modules/pages
`/mail`.

## Cross-module implications
If MAIL-8 cache lands first/after, actions must invalidate cached rows.

## Technical scope
### Files to inspect
`lib/mail/index.ts`, `lib/mail/{gmail,outlook,composio}.ts`, `MailModule.tsx`, `MessagePanel.tsx`, `ui/Modal.tsx` (confirm).
### Files likely to change
New `POST /api/mail/action` (or `PATCH /api/mail/message/[id]`), `lib/mail/index.ts` (`mutateMessage`), adapters, UI affordances.
### API routes
New mutate route; verify ownership.
### Database impact
None unless cache exists. No migration here.
### Integration impact
Composio Gmail (`GMAIL_*` modify/trash labels), Outlook (move/delete/`isRead`). Verify slugs; degrade gracefully (hide unsupported actions).
### Observability
Sentry `op:mutate action:<archive|delete|read> provider via`.

## Claude implementation prompt
Paste this into Claude:

```txt
Add archive/delete/mark-read to AXIS Mail (depends on MAIL-4).
1. INSPECT: lib/mail/index.ts, the three adapters, MailModule.tsx, MessagePanel.tsx, ui/Modal.tsx. Verify the exact Composio + direct tool/endpoints for: mark read/unread, archive (Gmail remove INBOX label / Outlook move to Archive), delete/trash. Do not invent slugs.
2. EXPLAIN: the action set each provider supports and any gaps.
3. IMPLEMENT: add mutateMessage(userId, {provider,email,id,action}) to lib/mail/index.ts + adapters; add a route (POST /api/mail/action) with auth + ownership check; wire optimistic UI in MailModule with revert-on-failure + toast; Delete uses Modal confirm. Hide actions a provider can't perform.
4. DO NOT change read/list/send paths; keep it additive. No silent failures.
5. ACCEPTANCE: each action updates UI optimistically, persists across refresh, reverts + warns on failure; ownership enforced.
6. MANUAL TEST: each action on Composio Gmail; verify state in the real mailbox + after refresh.
7. REGRESSION RISKS: accidental delete (confirm required), optimistic state desync.
8. FINAL RESPONSE: provider capability table, edits, checklist, tsc result.
```

## Acceptance criteria
- [ ] Mark-read/unread, Archive, Delete work on Composio Gmail (and Outlook where supported); unsupported actions are hidden, not broken.
- [ ] Optimistic update with revert + visible error on failure.
- [ ] Delete requires confirmation (`Modal`).
- [ ] Action route verifies the account/message belongs to the user.
- [ ] State persists across refresh (verified against the real mailbox).
- [ ] `tsc` clean; happy path no new Sentry error.

## Manual test checklist
- [ ] 1–4 standard. 5. Mark read → archive → delete (confirm) a test message; verify each in the real mailbox. 6. Force a failure → UI reverts + toast. 7. Refresh → state matches provider. 8. Vercel preview. 9. No new Sentry error (happy). 10. Read/send unaffected.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required unless MAIL-8 merged (then note cache invalidation). [ ] PR shows before/after mailbox state.

---

# [P1] Mail: pagination and load-more

## Linear metadata
- **Project:** Mail Production Slice
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `type:feature` `latency` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** M
- **Dependencies:** MAIL-4 (preferred); can follow MAIL-8
- **Blocks / blocked by:** Pairs with MAIL-8.
- **Suggested branch:** `claude/mail-pagination`
- **Suggested PR title:** `feat(mail): per-account pagination + load-more`
- **Suggested commit message:** `feat(mail): wire pageToken/skip pagination into the UI`

## Problem
Audit L4: inbox fetches page 1 for all accounts; no load-more. The route already accepts `pageToken`/`skip` but the UI never uses them.

## Current behavior
`/api/mail/inbox` supports `account`/`provider`/`pageToken`/`skip`, but `MailModule` calls it once with no paging; merged list is unbounded-but-shallow.

## Expected behavior
A **Load more** control fetches the next page per account (Gmail `pageToken`, Outlook `skip`), appending to the merged+sorted list; disabled when no more.

## User workflow
Scroll inbox → Load more → older messages append → state stable on refresh of page 1.

## Why this matters
Triage across multiple accounts needs depth; also reduces first-load payload.

## Affected modules/pages
`/mail`.

## Cross-module implications
If MAIL-8 cache exists, paginate the cache + background-extend.

## Technical scope
### Files to inspect
`MailModule.tsx` (fetch + state), `api/mail/inbox/route.ts` (already paginated), `lib/mail/index.ts`.
### Files likely to change
`MailModule.tsx` (per-account cursor state, Load-more), possibly `inbox` route to return per-account `nextPageToken`/`nextSkip`.
### API routes
`GET /api/mail/inbox` (ensure it returns next-cursor per account).
### Database impact
None (or cache cursor if MAIL-8). No migration here.
### Integration impact
Preserve Gmail `pageToken` + Outlook `skip` semantics.
### Observability
None new beyond MAIL-9.

## Claude implementation prompt
Paste this into Claude:

```txt
Wire pagination into AXIS Mail (route already supports pageToken/skip).
1. INSPECT: api/mail/inbox/route.ts (params + response), MailModule.tsx (fetch + messages state), lib/mail/index.ts.
2. EXPLAIN: how the route paginates per provider and what the response currently returns vs what the UI needs (per-account next cursor).
3. IMPLEMENT: ensure inbox response includes per-account next cursor (nextPageToken for gmail, nextSkip for outlook); add per-account cursor state + a "Load more" button in MailModule that fetches the next page per account and appends to the merged/sorted list; disable when all accounts exhausted.
4. DO NOT change detail/send/action paths; keep first-load behavior (page 1 all accounts).
5. ACCEPTANCE: Load more appends older messages without duplicates; disabled at end; refresh restores page 1.
6. MANUAL TEST: multi-account if possible; verify no dupes and correct ordering.
7. REGRESSION RISKS: duplicate rows on append, broken sort, lost account filter.
8. FINAL RESPONSE: explanation, edits, checklist, tsc result.
```

## Acceptance criteria
- [ ] "Load more" appends the next page per account; no duplicate rows; global date sort preserved.
- [ ] Control disables when no account has more.
- [ ] Account filter chips still scope correctly with pagination.
- [ ] Refresh restores page-1 state.
- [ ] `tsc` clean; no new Sentry error (happy).

## Manual test checklist
- [ ] 1–4 standard. 5. Load more several times → older messages appear, no dupes. 6. Disconnect-free error path: force one account to fail mid-page → others still paginate. 7. Refresh → page 1. 8. Vercel preview. 9. No new Sentry error. 10. Filtering + detail still work.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required (state in PR). [ ] PR notes multi-account test coverage.

---

# [P1] Mail: cache-first inbox architecture

## Linear metadata
- **Project:** Mail Production Slice ∩ Data Layer + Sync ∩ Latency
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `area:data` `latency` `cache` `migration` `rls` `review-needed`
- **Suggested assignee type:** Review-needed (schema + RLS)
- **Estimated complexity:** L
- **Dependencies:** DATA-1, DATA-4, DATA-5, MAIL-4
- **Blocks / blocked by:** Blocked by DATA-1/4/5 + MAIL-4. Improves MAIL-7.
- **Suggested branch:** `claude/mail-cache-first-inbox`
- **Suggested PR title:** `feat(mail): cache-first inbox with background sync`
- **Suggested commit message:** `feat(mail): add mail_messages cache + serve cached, revalidate async`

## Problem
Audit L2: `/api/mail/inbox` calls every provider live on every load → slow, network-dependent, and failures drop accounts silently.

## Current behavior
Read path = live provider fan-out; no persistence between loads.

## Expected behavior
Inbox renders instantly from a Supabase cache (`mail_messages`), then revalidates in the background; per-account sync state + errors are visible (ties to INT-7). First paint < 300 ms with no network.

## User workflow
Open `/mail` → cached messages instantly → "syncing…" indicator → list updates; offline → cached still shows with a stale badge.

## Why this matters
Mail is the most-used module; live fan-out makes it feel broken on slow networks.

## Affected modules/pages
`/mail`; depends on the sync-state model (DATA-4) and id-mapping (DATA-5).

## Cross-module implications
Establishes the cache+sync pattern Calendar/Briefing reuse.

## Technical scope
### Files to inspect
`api/mail/inbox/route.ts`, `lib/mail/index.ts`, DATA-4 sync-state, DATA-5 id-map, `lib/supabase/server.ts`.
### Files likely to change
New migration `0xx_mail_messages_cache.sql` (RLS owner-scoped); `lib/mail/sync.ts` (upsert from provider → cache); inbox route serves cache + triggers revalidate; `MailModule` shows sync/stale state.
### API routes
`GET /api/mail/inbox` (cache-first), new `POST /api/mail/sync` (or background revalidate).
### Database impact (Supabase/Tembo)
New `mail_messages` table keyed `(user_id, provider, account_email, provider_message_id)` + sync columns. **RLS: user-owned.** Confirm against DATA-1 ordering. **Tembo:** if DATA-7 finds Tembo is the analytics/queue layer, decide whether sync jobs enqueue via Tembo; otherwise Supabase only — document the decision.
### Integration impact
Composio + direct both write into the same cache via `lib/mail/index.ts`.
### Required env vars
None new unless a background queue is introduced.
### Security/RLS
Strict per-user RLS; never cache other users' mail; store body lazily or encrypted-at-rest per existing `lib/crypto.ts` conventions — confirm whether bodies should be cached at all (privacy).
### Error handling
Per-account sync errors recorded in sync-state (DATA-4) and surfaced (INT-7); a failing account never blanks the cache.
### Performance
Cache read indexed by `(user_id, account_email, date desc)`; revalidate async.

## Claude implementation prompt
Paste this into Claude:

```txt
Implement cache-first inbox for AXIS Mail. Depends on DATA-1 (migration ordering), DATA-4 (sync_state), DATA-5 (provider id map), MAIL-4 (lib/mail/index.ts). This touches schema + RLS — be conservative and explain before coding.
1. INSPECT: api/mail/inbox/route.ts, lib/mail/index.ts, DATA-4/DATA-5 outputs, an existing user-owned table migration (e.g. people) for the RLS pattern, lib/crypto.ts (for body-at-rest policy).
2. EXPLAIN: the proposed mail_messages schema (columns, keys, indexes, RLS), whether message BODIES should be cached (privacy trade-off — recommend headers/snippet cached, body fetched on open unless we decide otherwise), and the revalidate strategy. Get this reviewed conceptually before writing SQL.
3. IMPLEMENT: a numbered migration following DATA-1's scheme with owner-scoped RLS; lib/mail/sync.ts that upserts provider results into the cache and records sync_state; inbox route serves cache immediately then triggers async revalidate; MailModule shows a syncing/stale indicator. Per-account failures write to sync_state, never wipe cache.
4. DO NOT cache message bodies unless the explanation justified it; DO NOT change detail-open (still fetch body on open) or send/action paths beyond cache invalidation hooks; DO NOT bypass RLS with the admin client.
5. ACCEPTANCE: see issue; first paint from cache with no network; RLS verified.
6. MANUAL TEST: include an offline/airplane test and an RLS test (a second user sees none of your mail).
7. REGRESSION RISKS: RLS leak, stale cache never refreshing, body privacy.
8. FINAL RESPONSE: schema + RLS, migration filename, sync flow, checklist (incl. RLS + offline), tsc result, explicit migration-applied statement.
```

## Acceptance criteria
- [ ] `/mail` first paint renders cached messages with no network call (verify in devtools).
- [ ] Background revalidate updates the list; a syncing/stale indicator is visible.
- [ ] New `mail_messages` table has owner-scoped RLS; a second authenticated user cannot read another's rows.
- [ ] Per-account sync failure is recorded + surfaced and does not blank the cache.
- [ ] Message detail still fetches the body on open (or, if cached, the privacy decision is documented + RLS-safe).
- [ ] Migration follows DATA-1 numbering and is applied (or PR states why not).
- [ ] `tsc` clean; happy path no new Sentry error.

## Manual test checklist
- [ ] 1–4 standard. 5. Open `/mail` twice → second load instant from cache (devtools shows no provider fetch on paint). 6. Go offline → cached list still shows + stale badge; force one account error → recorded, others fine. 7. Refresh → cache persists; new mail appears after revalidate. 8. Vercel preview. 9. No new Sentry error (happy). 10. RLS: log in as a second user → zero leaked rows.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] **Migration applied** to the preview/branch DB; confirm via `list_migrations`. [ ] PR documents schema, RLS test evidence, and the body-caching decision.

---

# [P1] Mail: Sentry instrumentation for provider failures

## Linear metadata
- **Project:** Mail Production Slice ∩ Latency + Observability
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `observability` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** MAIL-4 (centralized dispatch is the natural capture point)
- **Blocks / blocked by:** Blocked by MAIL-4.
- **Suggested branch:** `claude/mail-sentry-instrumentation`
- **Suggested PR title:** `feat(observability): tag + capture mail provider failures in Sentry`
- **Suggested commit message:** `feat(mail): structured Sentry capture for provider ops`

## Problem
Mail provider failures are mostly silent (`Promise.allSettled` drops; 404/502 untracked). No way to see provider health in Sentry.

## Current behavior
Sentry is configured (`sentry.*.config.ts`) but mail provider errors aren't deliberately captured/tagged.

## Expected behavior
Every mail op (list/get/send/mutate/sync) failure is captured with tags `area:mail`, `op`, `provider`, `via`, and non-PII context (account email hashed/redacted, message id). Per-account list failures are captured even though the request still returns 200.

## User workflow
N/A (operational). Validated via Sentry dashboard.

## Why this matters
Closes the silent-failure gap; gives a provider-health signal for INT-3.

## Affected modules/pages
`lib/mail/index.ts` + the inbox per-account loop.

## Cross-module implications
Pattern reused by INT-6 (structured provider errors).

## Technical scope
### Files to inspect
`sentry.server.config.ts`, `lib/mail/index.ts`, `api/mail/inbox/route.ts` (allSettled loop), `lib/crypto.ts` (for hashing emails).
### Files likely to change
`lib/mail/index.ts` (capture wrapper), inbox route (capture rejected settlements).
### API routes
All `/api/mail/*` (no contract change).
### Database impact
None. No migration.
### Integration impact
None.
### Observability
This is the deliverable. Add a `captureProviderError(op, provider, via, err, ctx)` helper.
### Security/privacy
Never send raw email bodies or full addresses to Sentry; hash/redact.

## Claude implementation prompt
Paste this into Claude:

```txt
Add structured Sentry capture to AXIS mail provider ops (depends on MAIL-4).
1. INSPECT: sentry.server.config.ts, lib/mail/index.ts, api/mail/inbox/route.ts (the Promise.allSettled loop that currently drops failed accounts), lib/crypto.ts.
2. EXPLAIN: where failures are currently swallowed and what context is safe to send (no bodies, redact addresses).
3. IMPLEMENT: a captureProviderError(op, provider, via, err, ctx) helper (in lib/mail/index.ts or lib/observability) using Sentry.captureException with tags {area:"mail", op, provider, via} and extra {accountHash, messageId}. Call it in every catch in index.ts AND for each rejected settlement in the inbox loop (still return 200, but capture). Redact emails via a hash.
4. DO NOT change response shapes or UI; do not log bodies/addresses in plaintext.
5. ACCEPTANCE: forced failures appear in Sentry with correct tags; no PII; happy path emits nothing.
6. MANUAL TEST: force a per-account list failure and a detail 502; confirm both in Sentry; confirm happy path is silent.
7. REGRESSION RISKS: noisy Sentry (don't capture expected 404s as errors — use level/breadcrumb), PII leakage.
8. FINAL RESPONSE: explanation, edits, Sentry screenshots/event ids, tsc result.
```

## Acceptance criteria
- [ ] Forced list/detail/send failures produce Sentry events tagged `area:mail` + `op`/`provider`/`via`.
- [ ] Per-account inbox failures are captured even though the endpoint returns 200.
- [ ] No raw email body or full address in any Sentry payload (redacted/hashed).
- [ ] Expected 404 (not-found) is a breadcrumb/info, not an error.
- [ ] Happy paths emit no Sentry errors.
- [ ] `tsc` clean.

## Manual test checklist
- [ ] 1–4 standard. 5. Force a bad provider slug (list + detail) and a send failure → 3 distinct tagged Sentry events. 6. Confirm payloads contain no PII. 7. Happy path → Sentry silent. 8. Vercel preview (Sentry receives from preview env). 9. Confirm no event on success. 10. Other modules unaffected.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] Sentry receives tagged events from forced failures; none on happy path. [ ] Migrations not required (state in PR). [ ] PR links the Sentry events (redacted).

---

# [P1] Mail: Vercel preview test checklist (repeatable QA doc)

## Linear metadata
- **Project:** Mail Production Slice ∩ Production Hardening
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `type:chore` `observability` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** XS
- **Dependencies:** MAIL-1…9 (documents their combined surface)
- **Blocks / blocked by:** none.
- **Suggested branch:** `claude/mail-preview-checklist`
- **Suggested PR title:** `docs(mail): repeatable Vercel preview QA checklist`
- **Suggested commit message:** `docs(mail): add preview QA checklist for the mail slice`

## Problem
Mail QA is ad hoc; no single doc to run against a preview deploy before merging mail changes.

## Current behavior
Each PR re-derives test steps.

## Expected behavior
`docs/qa/mail-preview-checklist.md` enumerates the full mail slice happy/error/RLS/persistence checks to run on any Vercel preview, per provider path.

## User workflow
Reviewer opens the doc, runs it against the preview URL, pastes results into the PR.

## Why this matters
Makes "Done" objective and repeatable for the most fragile module.

## Affected modules/pages
Docs only.

## Cross-module implications
Template for per-project QA docs (Calendar, Dispatch).

## Technical scope
### Files to inspect
This plan, `docs/audits/axis-platform-audit.md`.
### Files likely to change
New `docs/qa/mail-preview-checklist.md`.
### API/DB/Integration impact
None. No migration.
### Observability
Checklist includes "verify Sentry has no new error for happy path."

## Claude implementation prompt
Paste this into Claude:

```txt
Write docs/qa/mail-preview-checklist.md for AXIS — a repeatable QA checklist to run against a Vercel preview before merging any mail change.
1. INSPECT: docs/linear/axis-mvp-issues.md (MAIL-1..9), docs/audits/axis-platform-audit.md (mail findings).
2. EXPLAIN: nothing to code; outline the sections first.
3. IMPLEMENT the doc with sections: Setup (login, connect Composio Gmail + Outlook + direct if available); Happy paths (list, open Gmail/Outlook, reply, send, archive/delete/mark-read, load-more); Error paths (provider down, 404, 502, offline cache); Persistence (refresh); RLS (second user sees nothing); Observability (no new Sentry error on happy path; forced-failure events appear); Sign-off table.
4. DO NOT add code.
5. ACCEPTANCE: every MAIL issue's acceptance criteria is represented as a runnable step.
6. MANUAL TEST: run the checklist once against local dev to confirm steps are accurate.
7. REGRESSION RISKS: none (docs).
8. FINAL RESPONSE: the doc path + a note confirming you ran it once.
```

## Acceptance criteria
- [ ] `docs/qa/mail-preview-checklist.md` covers every MAIL issue's flows across Composio + direct.
- [ ] Includes RLS, offline/cache, persistence, and Sentry checks.
- [ ] Steps are concrete (clickable) and were dry-run once.

## Manual test checklist
- [ ] 1. Open the doc. 2. Run setup. 3. Run happy paths. 4. Run error paths. 5. Run RLS. 6. Confirm Sentry section is accurate. 7. Confirm on a preview URL. 8–10. n/a.

## Deployment validation
- [ ] Vercel preview succeeds (docs change). [ ] No Sentry impact. [ ] No migration. [ ] PR links the new doc.

---
---

# PROJECT 3 — Integration Adapter Refactor

Generalizes MAIL-4's `MailAdapter` into a cross-domain pattern: a registry of provider adapters, normalized account records, a provider health model, structured errors, and a sync-state model. This is the spine that makes Mail/Calendar/Contacts (and later health/finance) uniform, observable, and reconnectable. Audit refs: A2, I3, I4, I5, U2.

---

# [P0] Integrations: create integration adapter registry

## Linear metadata
- **Project:** Integration Adapter Refactor
- **Priority:** P0
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `type:refactor` `review-needed`
- **Suggested assignee type:** Review-needed (sets cross-cutting contract)
- **Estimated complexity:** M
- **Dependencies:** MAIL-4 (proves the shape)
- **Blocks / blocked by:** Blocks INT-2…7, CAL refactors. Blocked by MAIL-4.
- **Suggested branch:** `claude/integrations-adapter-registry`
- **Suggested PR title:** `refactor(integrations): introduce provider adapter registry`
- **Suggested commit message:** `refactor(integrations): add IntegrationAdapter registry + types`

## Problem
Each domain (mail/calendar/contacts) re-implements provider selection, account listing, and connect/disconnect. There's no single place that knows "what providers exist, how to talk to each, and their capabilities."

## Current behavior
`lib/integrations/composio.ts` is shared, but domain adapters (`lib/mail/*`, `lib/calendar/*`, `lib/contacts/*`) are loosely related with no common interface; Control Room hardcodes provider lists.

## Expected behavior
`lib/integrations/registry.ts` defines `IntegrationAdapter` (id, domain, transport: composio|direct, capabilities, `connect/disconnect/listAccounts/health`) and registers mail/calendar/contacts adapters. Domain code + Control Room consume the registry rather than hardcoding.

## User workflow
Indirect: a consistent connect/disconnect/health experience across Control Room.

## Why this matters
Eliminates the structural duplication (A2) and is the prerequisite for INT-3 health, INT-5 reconnect, INT-7 sync-state.

## Affected modules/pages
Control Room, Mail/Calendar/People pickers (read the registry for available providers).

## Cross-module implications
Defines capability flags consumed everywhere (e.g. mail `canArchive`, calendar `canUpdate`).

## Technical scope
### Files to inspect
`lib/integrations/composio.ts`, `lib/mail/index.ts`, `lib/calendar/composio.ts`, `lib/contacts/composio.ts`, `components/control-room/ControlRoomModule.tsx`, `components/{mail,schedule,people}/*Picker.tsx`.
### Files likely to change
New `lib/integrations/registry.ts` + `types.ts`; adapters implement the interface; Control Room + pickers read the registry. Keep behavior identical.
### API routes
None changed (registry is server/shared lib).
### Database impact
None. No migration.
### Integration impact
Encodes Composio toolkits + the direct exceptions (Spotify/Strava/health) as registry entries with capabilities; respects the OAuth-consolidation policy (Composio-only connect for mail/cal/contacts).
### Observability
Registry exposes a stable `provider`/`domain` taxonomy for Sentry tags.
### Security
No secret handling moves; adapters keep using existing token/composio helpers.

## Claude implementation prompt
Paste this into Claude:

```txt
Create a provider adapter registry for AXIS integrations. No behavior change; depends on MAIL-4.
1. INSPECT: lib/integrations/composio.ts, lib/mail/index.ts, lib/calendar/composio.ts, lib/contacts/composio.ts, ControlRoomModule.tsx, the three *Picker components. Also read the memory/audit: mail/calendar/contacts connect is Composio-ONLY; Spotify/Strava/health are direct exceptions.
2. EXPLAIN: a table of domains × providers × transport × capabilities as they exist today.
3. IMPLEMENT lib/integrations/registry.ts: an IntegrationAdapter interface { id, domain, transport, capabilities, listAccounts(userId), health(userId), connectUrl(), disconnect(userId, account) } and a registry mapping. Implement adapters that DELEGATE to existing lib functions (do not rewrite provider logic). Refactor Control Room + pickers to read available providers/capabilities from the registry instead of hardcoded lists.
4. DO NOT change connect/disconnect behavior, response shapes, or the Composio-only policy; do not migrate Spotify/Strava/health off direct.
5. ACCEPTANCE: registry drives the provider lists; all connect/disconnect/list flows behave identically; tsc clean.
6. MANUAL TEST: Control Room shows the same providers; connect/disconnect a Composio account; pickers render correctly.
7. REGRESSION RISKS: a provider disappearing from a picker; capability flags wrong.
8. FINAL RESPONSE: the domains×providers table, the interface, list of consumers refactored, checklist, tsc result.
```

## Acceptance criteria
- [ ] `lib/integrations/registry.ts` defines `IntegrationAdapter` + registers mail/calendar/contacts (+ direct exceptions declared with capabilities).
- [ ] Control Room and the mail/schedule/people pickers read providers/capabilities from the registry (no hardcoded provider arrays for those domains).
- [ ] All connect/disconnect/list flows behave identically to before.
- [ ] Composio-only policy for mail/cal/contacts preserved; Spotify/Strava/health remain direct.
- [ ] `tsc` clean; no new Sentry errors on happy paths.

## Manual test checklist
- [ ] 1–3 standard. 4. Control Room → provider list identical. 5. Connect + disconnect a Composio account. 6. Open Mail/Schedule/People pickers → correct providers. 7. Refresh persists. 8. Vercel preview. 9. No new Sentry error. 10. Spotify/Strava still connect.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required (state in PR). [ ] PR shows provider parity before/after.

---

# [P0] Integrations: normalize provider account records

## Linear metadata
- **Project:** Integration Adapter Refactor ∩ Data Layer
- **Priority:** P0
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `area:data` `type:refactor` `rls` `review-needed`
- **Suggested assignee type:** Review-needed
- **Estimated complexity:** M
- **Dependencies:** INT-1, DATA-1
- **Blocks / blocked by:** Blocks INT-3, INT-5, INT-7. Blocked by INT-1.
- **Suggested branch:** `claude/integrations-normalize-accounts`
- **Suggested PR title:** `refactor(integrations): normalized ProviderAccount model`
- **Suggested commit message:** `refactor(integrations): unify account shape across composio + direct + legacy tables`

## Problem
Account records live in different tables/shapes: `composio_connections`, `mail_connections`, `calendar_connections`, `contacts_connections`, `user_strava_tokens`, `fund_connections`. There's no single `ProviderAccount` concept, which complicates health + reconnect.

## Current behavior
Each domain reads its own table(s); `listMailAccounts` merges two; calendar/contacts do their own thing; legacy tables (I3) are read but unfillable.

## Expected behavior
A normalized `ProviderAccount { userId, domain, provider, transport, externalAccountId, label, status, connectedAt }` produced by registry adapters, regardless of underlying table. Legacy/direct rows map into it; the half-removed direct path (I3) is explicitly represented (status `legacy`).

## User workflow
Indirect: consistent account display + status across Control Room.

## Why this matters
Health (INT-3), reconnect (INT-5), and sync-state (INT-7/DATA-4) all need one account identity.

## Affected modules/pages
Control Room, pickers, mail/calendar status routes.

## Cross-module implications
Surfaces the I3 decision: either map legacy direct accounts as `legacy` (read-only) or exclude them.

## Technical scope
### Files to inspect
`lib/mail/tokens.ts`, `lib/calendar/tokens.ts`, `lib/contacts/composio.ts`, `composio_connections` schema, all `*_connections` tables.
### Files likely to change
`lib/integrations/registry.ts` (`listAccounts` → `ProviderAccount[]`), domain `listAccounts` adapters, Control Room rendering.
### API routes
`/api/mail/status`, `/api/calendar/status`, `/api/integrations/composio/status` (return normalized shape; keep backwards-compatible fields if UI depends on them).
### Database impact
Read-only normalization; **no new table** here (sync-state table is DATA-4). No migration unless a status enum column is added — prefer none.
### Integration impact
Encodes which providers are composio vs direct vs legacy.
### Security/RLS
All reads remain user-scoped; never read another user's connection rows.

## Claude implementation prompt
Paste this into Claude:

```txt
Normalize AXIS provider account records into one ProviderAccount shape (depends on INT-1, DATA-1).
1. INSPECT: lib/mail/tokens.ts, lib/calendar/tokens.ts, lib/contacts/composio.ts, the composio_connections + *_connections table columns, /api/{mail,calendar}/status routes.
2. EXPLAIN: a table of every account source, its columns, and how each maps to ProviderAccount {userId,domain,provider,transport,externalAccountId,label,status,connectedAt}. Call out legacy direct mail/calendar rows (finding I3) and propose status:"legacy" for them.
3. IMPLEMENT: ProviderAccount type + registry adapter listAccounts returning it; map composio + direct + legacy rows; update status routes to return the normalized list (keep any field the UI currently reads, additively). Update Control Room to render from ProviderAccount.
4. DO NOT add tables, change RLS, or delete legacy rows; keep status route backwards-compatible.
5. ACCEPTANCE: Control Room + pickers show the same accounts with correct status; legacy direct accounts show as legacy; tsc clean.
6. MANUAL TEST: verify each connected account appears once with correct provider/transport/status.
7. REGRESSION RISKS: duplicate/missing accounts, broken status route consumers.
8. FINAL RESPONSE: the mapping table, type, route changes, checklist, tsc result.
```

## Acceptance criteria
- [ ] A single `ProviderAccount` type is produced by registry adapters across composio/direct/legacy sources.
- [ ] Status routes return the normalized list (backwards-compatible).
- [ ] Legacy direct mail/calendar accounts are represented with a distinct `legacy` status (I3 made visible).
- [ ] No account is duplicated or dropped in Control Room.
- [ ] No RLS change; reads remain user-scoped. `tsc` clean.

## Manual test checklist
- [ ] 1–3 standard. 4. Control Room → each account once, correct provider/transport/status. 5. If a legacy direct row exists, it shows as legacy. 6. Connect a new Composio account → appears normalized. 7. Refresh persists. 8. Vercel preview. 9. No new Sentry error. 10. Mail/Calendar status-dependent UI still works.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migrations not required (state in PR) unless a status column is justified. [ ] PR includes the source→ProviderAccount mapping table.

---

# [P1] Integrations: add provider health model

## Linear metadata
- **Project:** Integration Adapter Refactor ∩ Integration Health + Control Room
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `observability` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** M
- **Dependencies:** INT-1, INT-2, INT-6
- **Blocks / blocked by:** Blocks INT-4. Blocked by INT-1/2/6.
- **Suggested branch:** `claude/integrations-health-model`
- **Suggested PR title:** `feat(integrations): provider health probes + status model`
- **Suggested commit message:** `feat(integrations): add health() probes per adapter`

## Problem
There's no programmatic "is this connection actually working?" — accounts can be silently expired/revoked (e.g. Composio token revoked, Strava cookie gone).

## Current behavior
Status routes report "connected" if a row exists, not whether the provider call succeeds.

## Expected behavior
Each adapter implements `health(userId, account): { ok, lastChecked, latencyMs, error? }` via a cheap probe (e.g. Gmail profile fetch). A `GET /api/integrations/health` aggregates per account, cached briefly.

## User workflow
Control Room shows green/amber/red per account (rendered in INT-4).

## Why this matters
Turns "connected" into "working," enabling reconnect (INT-5) before the user hits a failure.

## Affected modules/pages
Control Room (consumed in INT-4).

## Cross-module implications
Health signal can gate cache-first sync (MAIL-8) and Agenda/Calendar reliability.

## Technical scope
### Files to inspect
`lib/integrations/registry.ts`, `lib/integrations/composio.ts` (`resolveProfileLabel` is already a cheap probe), `lib/mail/index.ts`, `lib/calendar/composio.ts`.
### Files likely to change
Adapter `health()` impls; new `app/api/integrations/health/route.ts`.
### API routes
New `GET /api/integrations/health` (auth + per-account probe + short cache).
### Database impact
Optional: write last health to `composio_connections`/sync-state (DATA-4) — prefer reusing DATA-4 if available, else in-memory/short cache. No new table here.
### Integration impact
Probe must be cheap + safe (read-only profile/metadata calls); rate-limit to avoid hammering providers.
### Observability
Health failures captured to Sentry (`op:health`) using INT-6 structured errors.
### Performance
Probes run in parallel with a timeout; results cached ~60s to avoid per-render probing.

## Claude implementation prompt
Paste this into Claude:

```txt
Add per-provider health probes to AXIS integrations (depends on INT-1/2/6).
1. INSPECT: lib/integrations/registry.ts, lib/integrations/composio.ts (resolveProfileLabel as a cheap probe), lib/mail/index.ts, lib/calendar/composio.ts.
2. EXPLAIN: the cheapest read-only probe per provider and the caching/timeout strategy.
3. IMPLEMENT: health(userId, account) on each adapter returning {ok,lastChecked,latencyMs,error?} using a cheap read-only call with a timeout; a GET /api/integrations/health route that runs probes in parallel, caches ~60s, and returns per-account health. Capture failures via INT-6 structured errors + Sentry op:health. Rate-limit via the existing ratelimit util.
4. DO NOT mutate provider data in a probe; do not probe on every render (cache); do not change connect/disconnect.
5. ACCEPTANCE: revoking/expiring an account flips health to red within the cache window; healthy accounts report ok + latency.
6. MANUAL TEST: connect an account (ok), then revoke it provider-side or disconnect token → health goes red.
7. REGRESSION RISKS: probe cost/rate limits, false negatives from transient errors (use a short retry or mark amber).
8. FINAL RESPONSE: probe-per-provider table, route, caching approach, checklist, tsc result.
```

## Acceptance criteria
- [ ] Each registry adapter implements a cheap, read-only `health()` with timeout.
- [ ] `GET /api/integrations/health` returns per-account `{ok,lastChecked,latencyMs,error?}`, cached ~60s, rate-limited.
- [ ] A revoked/expired account reports `ok:false` within the cache window; healthy reports `ok:true`.
- [ ] Health failures are captured to Sentry (`op:health`) with structured errors (INT-6).
- [ ] `tsc` clean; healthy probes create no Sentry errors.

## Manual test checklist
- [ ] 1–3 standard. 4. Hit `/api/integrations/health` → connected accounts ok + latency. 5. Revoke/disconnect one account provider-side → health red. 6. Re-check within a minute (cache) then after → reflects state. 7. Vercel preview. 8. No new Sentry error for healthy probes. 9. Confirm rate-limit holds under repeated calls. 10. Connect/disconnect still work.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] Sentry: only forced-failure health events. [ ] Migration not required unless DATA-4 reused (state which). [ ] PR includes a health JSON sample (redacted).

---

# [P1] Integrations: surface integration status in Control Room

## Linear metadata
- **Project:** Integration Health + Control Room
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `area:ux` `type:feature` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** M
- **Dependencies:** INT-2, INT-3
- **Blocks / blocked by:** Blocks INT-5. Blocked by INT-2/3.
- **Suggested branch:** `claude/control-room-integration-status`
- **Suggested PR title:** `feat(control-room): per-account integration health + status UI`
- **Suggested commit message:** `feat(control-room): render integration health badges`

## Problem
Control Room shows connect/disconnect but not whether a connection works; users discover breakage only when a module fails.

## Current behavior
Control Room (1,317 LOC, 19 inline fetches) lists integrations with connect/disconnect, no health.

## Expected behavior
Each account row shows a health badge (green/amber/red) from INT-3, last-checked time, latency, and the error reason on red. A "Recheck" button re-probes.

## User workflow
Open Control Room → see which integrations are healthy → spot a red Gmail → (INT-5) reconnect.

## Why this matters
Makes integration breakage visible (closes the silent-failure theme at the hub).

## Affected modules/pages
`/control-room`.

## Cross-module implications
The status surface is where INT-5 reconnect attaches.

## Technical scope
### Files to inspect
`components/control-room/ControlRoomModule.tsx`, `ControlRoom.module.css`, `app/api/integrations/health/route.ts` (INT-3), normalized accounts (INT-2).
### Files likely to change
`ControlRoomModule.tsx` (consume health + render badges); ideally extract an `IntegrationRow`/`useIntegrationHealth` to start de-bloating (A1) — keep scope tight.
### API routes
Consumes `GET /api/integrations/health`.
### Database impact
None. No migration.
### Integration impact
None new.
### Observability
Client logs a breadcrumb on Recheck; errors come from INT-3.
### Performance
Fetch health once on mount + on Recheck; do not poll aggressively.

## Claude implementation prompt
Paste this into Claude:

```txt
Render integration health in AXIS Control Room (depends on INT-2 normalized accounts, INT-3 health API).
1. INSPECT: ControlRoomModule.tsx (how it lists accounts + the 19 fetches), ControlRoom.module.css, /api/integrations/health, the ProviderAccount shape.
2. EXPLAIN: where account rows render today and how you'll attach health without a big refactor.
3. IMPLEMENT: a small useIntegrationHealth() hook that fetches /api/integrations/health once on mount; render per-account badge (green ok / amber transient / red error) + lastChecked + latency + error reason on red; add a Recheck button. Optionally extract IntegrationRow for clarity — but keep the diff focused.
4. DO NOT rewrite all of Control Room, change connect/disconnect, or add polling.
5. ACCEPTANCE: healthy accounts show green+latency; a broken one shows red+reason; Recheck re-probes.
6. MANUAL TEST: with a healthy and a broken account, verify badges + Recheck.
7. REGRESSION RISKS: layout breakage, over-fetching health.
8. FINAL RESPONSE: explanation, edits, screenshots (healthy+broken), checklist, tsc result.
```

## Acceptance criteria
- [ ] Each integration account row shows a health badge + last-checked + latency, sourced from `/api/integrations/health`.
- [ ] Red rows show the error reason; a **Recheck** re-probes that account/all.
- [ ] Health is fetched once on mount (+ on Recheck), not polled.
- [ ] Existing connect/disconnect unchanged.
- [ ] `tsc` clean; no new Sentry error on healthy load.

## Manual test checklist
- [ ] 1–3 standard. 4. Open Control Room → healthy accounts green + latency. 5. Break one account → red + reason after Recheck. 6. Recheck restores after fixing. 7. Refresh persists. 8. Vercel preview. 9. No new Sentry error (healthy). 10. Connect/disconnect still work.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (healthy). [ ] Migration not required (state in PR). [ ] PR includes healthy + broken screenshots.

---

# [P1] Integrations: user-visible reconnect flow

## Linear metadata
- **Project:** Integration Health + Control Room
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `area:ux` `type:feature` `review-needed`
- **Suggested assignee type:** Review-needed (OAuth/Composio flow)
- **Estimated complexity:** M
- **Dependencies:** INT-4
- **Blocks / blocked by:** Blocked by INT-4.
- **Suggested branch:** `claude/integrations-reconnect-flow`
- **Suggested PR title:** `feat(integrations): one-click reconnect for unhealthy accounts`
- **Suggested commit message:** `feat(integrations): reconnect flow for expired/revoked accounts`

## Problem
When an account goes red, there's no guided way to fix it; the user must disconnect + reconnect manually (and for legacy direct accounts, there's no connect route at all — I3).

## Current behavior
Disconnect + reconnect are separate; no "reconnect" affordance tied to health.

## Expected behavior
A red account shows **Reconnect** → launches the correct connect flow (Composio popup via `openOAuthPopup`/`/api/integrations/composio/connect`) → on success, health flips green. Legacy direct accounts prompt to "reconnect via Composio" (per the consolidation policy).

## User workflow
Control Room → red Gmail → Reconnect → Composio popup → authorize → green.

## Why this matters
Turns breakage into a one-click fix; resolves the I3 dead-end for users.

## Affected modules/pages
`/control-room`, `lib/auth/openOAuthPopup.ts`, `/oauth-done`.

## Cross-module implications
After reconnect, dependent caches (MAIL-8) should revalidate.

## Technical scope
### Files to inspect
`ControlRoomModule.tsx`, `lib/auth/openOAuthPopup.ts`, `app/api/integrations/composio/connect/route.ts`, `app/oauth-done/page.tsx`, INT-2 (legacy status).
### Files likely to change
`ControlRoomModule.tsx` (Reconnect button + popup handling + health re-probe on return); messaging for legacy accounts.
### API routes
Reuses `/api/integrations/composio/connect` (+ disconnect for legacy migration).
### Database impact
None new. No migration.
### Integration impact
Composio connect popup; for legacy direct, guide to Composio reconnect then drop the legacy row.
### Observability
Sentry breadcrumb on reconnect start/success/failure.
### Security
Reconnect must re-verify the session; never reconnect another user's account.

## Claude implementation prompt
Paste this into Claude:

```txt
Add a reconnect flow to AXIS Control Room (depends on INT-4).
1. INSPECT: ControlRoomModule.tsx (health rows from INT-4), lib/auth/openOAuthPopup.ts, app/api/integrations/composio/connect/route.ts, app/oauth-done/page.tsx, INT-2 legacy status.
2. EXPLAIN: the existing connect popup mechanics and how you'll re-probe health when the popup returns.
3. IMPLEMENT: a Reconnect button on red (and legacy) rows → openOAuthPopup to the composio connect URL for that toolkit → on /oauth-done return, re-probe health for that account and update the badge. For legacy direct accounts, label it "Reconnect via Composio" and, on success, disconnect the legacy row.
4. DO NOT add a direct-OAuth connect route (policy: Composio-only for mail/cal/contacts); don't touch Spotify/Strava reconnect.
5. ACCEPTANCE: reconnecting a red account flips it green; legacy account becomes a Composio account.
6. MANUAL TEST: break → reconnect → green; legacy → migrate.
7. REGRESSION RISKS: popup/session edge cases, leaving the account in a half state.
8. FINAL RESPONSE: explanation, edits, checklist, tsc result.
```

## Acceptance criteria
- [ ] A red/legacy account shows **Reconnect**; clicking launches the Composio connect popup for the right toolkit.
- [ ] On success, the account's health re-probes and shows green without a full page reload.
- [ ] Legacy direct accounts reconnect via Composio and the legacy row is removed.
- [ ] Session/ownership re-verified; no direct-OAuth connect route added.
- [ ] `tsc` clean; happy path no new Sentry error.

## Manual test checklist
- [ ] 1–3 standard. 4. Break a Composio account → red. 5. Reconnect → popup → authorize → green. 6. (If a legacy row exists) reconnect via Composio → becomes Composio, legacy gone. 7. Refresh persists. 8. Vercel preview. 9. No new Sentry error (happy). 10. Mail still reads after reconnect.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Migration not required (state in PR). [ ] PR shows break→reconnect→green.

---

# [P0] Integrations: structured provider errors

## Linear metadata
- **Project:** Integration Adapter Refactor ∩ Latency + Observability
- **Priority:** P0
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `observability` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** INT-1
- **Blocks / blocked by:** Blocks INT-3, MAIL-9 (shared error type). Blocked by INT-1.
- **Suggested branch:** `claude/integrations-structured-errors`
- **Suggested PR title:** `feat(integrations): structured ProviderError type + mapping`
- **Suggested commit message:** `feat(integrations): standardize provider error codes`

## Problem
Provider failures are stringly-typed (`res.error ?? "Send failed"`), so callers can't distinguish auth-expired vs rate-limited vs not-found vs transient — which blocks health (INT-3), reconnect (INT-5), and good UX.

## Current behavior
Adapters return ad hoc `{ ok:false, error:string }` or throw raw errors.

## Expected behavior
A `ProviderError { code: "auth_expired"|"rate_limited"|"not_found"|"transient"|"unknown", provider, domain, httpStatus?, message }` produced by a single mapper from Composio/direct responses; routes translate `code` → HTTP status + UI message.

## User workflow
Indirect: error states become specific ("Reconnect Gmail" vs "Try again").

## Why this matters
Specific errors are the difference between a reconnect prompt and a useless "something went wrong."

## Affected modules/pages
All integration domains; consumed by MAIL-3/9, INT-3/4/5.

## Technical scope
### Files to inspect
`lib/integrations/composio.ts` (`executeTool` result), `lib/mail/index.ts`, `lib/calendar/composio.ts`.
### Files likely to change
New `lib/integrations/errors.ts` (`ProviderError` + `mapProviderError`); adapters use it; routes map code→status.
### API routes
All integration routes return `{ error, code }` consistently.
### Database impact
None. No migration.
### Integration impact
Map Composio error payloads + HTTP statuses to codes; same for direct (401→auth_expired, 429→rate_limited).
### Observability
`ProviderError.code` becomes a Sentry tag.
### Security
Error messages must not leak tokens/PII.

## Claude implementation prompt
Paste this into Claude:

```txt
Add structured provider errors to AXIS integrations (depends on INT-1).
1. INSPECT: lib/integrations/composio.ts (executeTool result shape + error fields), lib/mail/index.ts, lib/calendar/composio.ts.
2. EXPLAIN: the error shapes each transport returns and how to classify them.
3. IMPLEMENT: lib/integrations/errors.ts with ProviderError + mapProviderError(raw, {provider,domain}) → classifies into auth_expired/rate_limited/not_found/transient/unknown (map 401/403→auth_expired, 429→rate_limited, 404→not_found, 5xx/network→transient). Use it in adapters; have routes translate code→HTTP status + a safe message. No token/PII in messages.
4. DO NOT change happy-path response shapes beyond adding `code` to error responses; don't rewrite adapters' success logic.
5. ACCEPTANCE: forcing each failure class yields the right code + HTTP status + message; no PII.
6. MANUAL TEST: simulate 401, 429, 404, 5xx and verify classification.
7. REGRESSION RISKS: misclassification (transient as auth_expired causing false reconnect prompts).
8. FINAL RESPONSE: classification table, errors.ts API, consumers updated, checklist, tsc result.
```

## Acceptance criteria
- [ ] `lib/integrations/errors.ts` exports `ProviderError` + `mapProviderError`, classifying into the 5 codes.
- [ ] Integration routes return `{ error, code }` with an HTTP status matching the code.
- [ ] 401/403→auth_expired, 429→rate_limited, 404→not_found, 5xx/network→transient.
- [ ] No tokens/PII in any error message.
- [ ] `tsc` clean; consumed by mail error UI (MAIL-3) without breakage.

## Manual test checklist
- [ ] 1–3 standard. 4. Force a 401 (revoke) → code `auth_expired`. 5. Force 429 → `rate_limited`. 6. Force 404 → `not_found`; 5xx → `transient`. 7. Confirm UI messages differ appropriately. 8. Vercel preview. 9. Sentry tags include `code`. 10. Happy paths unaffected.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] Sentry shows `code` tag on forced errors; none on happy path. [ ] Migration not required (state in PR). [ ] PR includes the classification table.

---

# [P1] Integrations: sync-state model for provider data

## Linear metadata
- **Project:** Integration Adapter Refactor ∩ Data Layer + Sync
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `area:data` `migration` `rls` `cache` `review-needed`
- **Suggested assignee type:** Review-needed (schema + RLS)
- **Estimated complexity:** M
- **Dependencies:** DATA-1, DATA-4, INT-2
- **Blocks / blocked by:** Enables MAIL-8 sync visibility. Blocked by DATA-1/4, INT-2.
- **Suggested branch:** `claude/integrations-sync-state`
- **Suggested PR title:** `feat(integrations): per-account sync-state surface`
- **Suggested commit message:** `feat(integrations): wire sync_state into adapters`

## Problem
There's no record of "when did we last successfully sync this account, and did the last sync fail?" — needed for cache-first reads + honest UI.

## Current behavior
Reads are live; nothing tracks last-sync/last-error per account.

## Expected behavior
Adapters write to the `sync_state` table (DATA-4) on each sync: `last_synced_at`, `last_status`, `last_error_code`, `cursor`. Control Room + Mail surface "Last synced 2m ago / Sync failed: reconnect."

## User workflow
Indirect; visible as freshness/error labels.

## Why this matters
Cache-first (MAIL-8) is only trustworthy if staleness/error are visible.

## Technical scope
### Files to inspect
DATA-4 `sync_state` schema, `lib/mail/sync.ts` (MAIL-8), `lib/integrations/registry.ts`.
### Files likely to change
Adapters/sync functions write `sync_state`; Control Room + Mail read it.
### API routes
`/api/integrations/health` or a `/api/integrations/sync-state` read; sync writers in domain sync libs.
### Database impact
Uses DATA-4's `sync_state` (no new table here); confirm RLS.
### Integration impact
Every sync path records state + cursor.
### Observability
Sync failures already captured (MAIL-9/INT-6); sync-state is the persistent counterpart.
### Security/RLS
User-scoped rows only.

## Claude implementation prompt
Paste this into Claude:

```txt
Wire per-account sync-state into AXIS integrations (depends on DATA-1, DATA-4 sync_state table, INT-2).
1. INSPECT: DATA-4 sync_state schema + RLS, lib/integrations/registry.ts, lib/mail/sync.ts (if MAIL-8 merged), the status/health routes.
2. EXPLAIN: which sync paths exist and what each should record (last_synced_at, last_status, last_error_code, cursor).
3. IMPLEMENT: have each sync/list-refresh path upsert sync_state for the account; expose it (extend health route or add /api/integrations/sync-state); render "last synced / sync failed" in Control Room + a stale/syncing indicator in Mail.
4. DO NOT add a new table (use DATA-4); don't bypass RLS; don't change provider read logic.
5. ACCEPTANCE: after a sync, sync_state reflects time/status/cursor; a failed sync shows last_error_code; UI shows freshness.
6. MANUAL TEST: sync ok → fresh label; force a failure → "sync failed: <code>"; verify RLS.
7. REGRESSION RISKS: stale labels not updating, RLS leak.
8. FINAL RESPONSE: which paths write sync_state, UI surfaces, checklist (incl RLS), tsc result, migration-applied note (DATA-4).
```

## Acceptance criteria
- [ ] Each sync path upserts `sync_state` (last_synced_at, last_status, last_error_code, cursor) per account.
- [ ] Control Room shows freshness; Mail shows a stale/syncing indicator sourced from `sync_state`.
- [ ] A failed sync records `last_error_code` (from INT-6) and is surfaced.
- [ ] `sync_state` reads/writes are user-scoped (RLS verified).
- [ ] `tsc` clean; happy sync emits no Sentry error.

## Manual test checklist
- [ ] 1–3 standard. 4. Trigger a sync → fresh "last synced" label. 5. Force a sync failure → "sync failed: <code>". 6. Recover → label updates. 7. Refresh persists. 8. Vercel preview. 9. RLS: second user sees none. 10. Mail/Control Room otherwise unaffected.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] Uses DATA-4 migration (confirm applied via `list_migrations`). [ ] PR includes RLS test evidence.

---
---

# PROJECT 8 — Data Layer + Sync Architecture

Makes the schema deterministic and the cache/sync model real. Audit refs: A4 (migration ordering), A5 (untyped client / dead types), A3 (localStorage fallback), L2 (no cache). Also resolves the **open Tembo question** — its role is undocumented and must be inspected, not assumed.

---

# [P0] Data: audit + reconcile current Supabase migrations

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:data` `migration` `review-needed`
- **Suggested assignee type:** Review-needed (Claude audits; human approves renumber before any prod replay)
- **Estimated complexity:** M
- **Dependencies:** none (do this first)
- **Blocks / blocked by:** Blocks MAIL-8, DATA-3/4/5/6, INT-7. Blocked by: none.
- **Suggested branch:** `claude/data-migration-audit`
- **Suggested PR title:** `chore(db): reconcile migration ordering + document applied state`
- **Suggested commit message:** `chore(db): renumber migrations to a deterministic sequence`

## Problem
Audit A4: `supabase/migrations` has duplicate numeric prefixes (`020_`×2, `036_`×2), a gap (`025`), and ~15 unnumbered files. `supabase db push` sorts by filename, so a fresh replay is nondeterministic — risking missing tables in prod, which silently triggers the localStorage fallback (A3).

## Current behavior
Mixed numbered/unnumbered files; collisions; no in-repo record of what's actually applied to the remote project.

## Expected behavior
A documented, deterministic ordering: every migration uniquely prefixed and ordered; a `supabase/migrations/README.md` (or header manifest) listing applied vs pending against the remote project (verified via the Supabase MCP `list_migrations`). A clean replay on an empty project succeeds.

## User workflow
N/A (infra).

## Why this matters
Everything in DATA + MAIL-8 + INT-7 adds tables; without deterministic ordering those migrations can't be trusted on a fresh environment or preview branch.

## Affected modules/pages
None directly; underpins all persistence.

## Cross-module implications
Unblocks every schema-touching issue.

## Technical scope
### Files to inspect
All of `supabase/migrations/`; `README.md` (migration section); the Supabase MCP `list_migrations` output for the linked project.
### Files likely to change
Rename/renumber migration files into a monotonic sequence (or CLI timestamp format) **without altering already-applied SQL semantics**; add a manifest doc. **Do not edit the body of migrations already applied to prod** — only fold in the unnumbered/duplicate ones safely.
### API routes
None.
### Database impact (Supabase/Tembo)
This is the schema-governance issue. Reconcile repo ⇄ remote. **Verify with `mcp__supabase__list_migrations`.** Do NOT `db push` to prod as part of this issue — only document + reorder + verify a clean replay on a throwaway branch DB.
### Required migrations
This issue *is* migration governance; no new schema.
### Security/RLS
Confirm no migration is missing an RLS policy (cross-check audit: `027_security_definer_lockdown`, `028_revoke_public_execute`, `031_fix_rls_*`, `032_*policy_invoker`).
### Error handling
N/A.
### Performance
N/A.

## Claude implementation prompt
Paste this into Claude:

```txt
Audit and reconcile AXIS Supabase migrations (do this before any schema work). Be conservative — DO NOT push to prod.
1. INSPECT: list every file in supabase/migrations and note number, name, and whether it's numbered. Call out duplicates (020_×2, 036_×2), the 025 gap, and all unnumbered files. Then call the Supabase MCP list_migrations to see what's APPLIED on the remote project. Read README.md migration instructions.
2. EXPLAIN: a full table of file → intended order → applied?(yes/no/unknown) → RLS present?(if it creates tables). Identify any table that exists in code/queries but has no clearly-ordered migration.
3. IMPLEMENT (governance only): propose a deterministic ordering. For files already applied to prod, keep their SQL identical (only document order). For unnumbered/duplicate files, assign unique sequential prefixes that preserve dependency order. Add supabase/migrations/README.md (a manifest: order, applied status, one-line purpose). Verify a clean replay on a fresh/branch database if available via MCP (create_branch / reset). DO NOT run db push against production.
4. DO NOT change SQL semantics of applied migrations; do not create new tables here; do not assume Tembo (that's DATA-7/8).
5. ACCEPTANCE: unique gapless ordering; manifest documents applied vs pending; a clean replay succeeds on a throwaway DB; every table-creating migration has an RLS policy noted.
6. MANUAL TEST: dry replay on a branch DB (or document why not possible) + list_migrations diff.
7. REGRESSION RISKS: reordering a migration ahead of its dependency; renaming an applied migration in a way that makes Supabase think it's new.
8. FINAL RESPONSE: the file→order→applied→RLS table, the manifest, replay result, and an explicit "did/didn't touch prod" statement.
```

## Acceptance criteria
- [ ] Every migration has a unique, ordered prefix; the `020_`/`036_` collisions and the `025` gap are resolved; unnumbered files are folded into the sequence.
- [ ] A manifest (`supabase/migrations/README.md`) lists order, applied status, and purpose, reconciled against `list_migrations`.
- [ ] A clean replay on a fresh/branch DB succeeds end-to-end (or the PR documents why a branch DB wasn't available).
- [ ] Every table-creating migration is confirmed to have an RLS policy.
- [ ] No SQL semantics of already-applied migrations changed; prod untouched.

## Manual test checklist
- [ ] 1. Enumerate migrations + `list_migrations`. 2. Build the reconciliation table. 3. Apply renumbering. 4. (If possible) create a Supabase branch and replay clean. 5. Diff applied vs repo. 6. Confirm RLS on each table-creating file. 7. n/a UI. 8. n/a preview. 9. n/a Sentry. 10. Confirm app still builds (`tsc` + `next build`).

## Deployment validation
- [ ] `next build` succeeds. [ ] No prod migration executed (explicitly stated). [ ] Replay verified on a branch DB or documented as deferred. [ ] PR includes the reconciliation table + manifest.

---

# [P0] Data: identify missing tables (code-vs-schema gap)

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:data` `migration` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** DATA-1
- **Blocks / blocked by:** Informs A3 fix, MAIL-8, health-device decision. Blocked by DATA-1.
- **Suggested branch:** `claude/data-missing-tables-audit`
- **Suggested PR title:** `docs(db): catalog code-referenced tables vs migrations`
- **Suggested commit message:** `docs(db): identify tables referenced in code but missing/unordered`

## Problem
Some code paths query tables whose migrations are unnumbered (may be unapplied), and some hooks fall back to localStorage when a table "looks missing" (A3). We need a definitive list of code-referenced tables vs what exists in the DB.

## Current behavior
No reconciliation between `.from("…")` calls and the schema; the silent localStorage fallback masks gaps.

## Expected behavior
A document listing every table referenced in `src` and whether it exists in the (reconciled) schema + remote DB; flag any gap; explicitly confirm `literature_prefs`, `fitness_routines`, `nutrition_protocol` (the A3 fallback tables) exist so the fallbacks can later be removed.

## User workflow
N/A.

## Why this matters
Prerequisite to removing the silent localStorage fallbacks (A3) safely and to deciding the health-device table.

## Technical scope
### Files to inspect
All `.from("…")` usages in `src`; the reconciled migration set (DATA-1); `list_tables` via MCP.
### Files likely to change
New `docs/db/table-inventory.md`.
### API/DB impact
Read-only audit; uses `mcp__supabase__list_tables`. No migration.
### Integration impact
Flags the missing `health_*` token table (I1) as a gap if the team pursues health.
### Security/RLS
Note any code-referenced table lacking RLS.

## Claude implementation prompt
Paste this into Claude:

```txt
Catalog AXIS code-referenced tables vs the actual schema (depends on DATA-1).
1. INSPECT: grep all `.from("...")` (and any rpc names) across src; read the DATA-1 reconciled manifest; call Supabase MCP list_tables.
2. EXPLAIN: nothing to code; outline the inventory columns.
3. IMPLEMENT docs/db/table-inventory.md: table | referenced in (files) | migration file | exists in remote? | RLS? | notes. Flag: any referenced table missing from schema/remote; the A3 fallback tables (literature_prefs, fitness_routines, nutrition_protocol) and confirm they exist; the absent health-token table (I1); the dead fund_snapshots (dropped in 020) still referenced by src/lib/types/database.ts.
4. DO NOT create tables or change code.
5. ACCEPTANCE: every `.from()` target appears in the inventory with an exists/RLS verdict; gaps flagged.
6. MANUAL TEST: spot-check 5 tables against list_tables.
7. REGRESSION RISKS: none (docs).
8. FINAL RESPONSE: the inventory doc + a short "gaps to fix" list mapped to issues (A3 removal, I1 health, A5 dead type).
```

## Acceptance criteria
- [ ] `docs/db/table-inventory.md` lists every code-referenced table with exists-in-remote + RLS verdicts.
- [ ] The A3 fallback tables are confirmed present (or flagged absent).
- [ ] The missing health-token table (I1) and dead `fund_snapshots` reference are flagged.
- [ ] A prioritized "gaps to fix" list maps to follow-up issues.

## Manual test checklist
- [ ] 1. Grep `.from()` targets. 2. Cross-ref manifest + `list_tables`. 3. Build inventory. 4. Spot-check 5 tables. 5. Confirm A3 tables. 6–10. n/a.

## Deployment validation
- [ ] `next build` unaffected. [ ] No migration. [ ] No prod change. [ ] PR includes the inventory + gaps list.

---

# [P1] Data: add normalized mail cache table (if MAIL-8 confirms need)

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:data` `area:mail` `migration` `rls` `cache` `review-needed`
- **Suggested assignee type:** Review-needed
- **Estimated complexity:** M
- **Dependencies:** DATA-1, DATA-5
- **Blocks / blocked by:** Blocks MAIL-8. Blocked by DATA-1/5.
- **Suggested branch:** `claude/data-mail-cache-table`
- **Suggested PR title:** `feat(db): mail_messages cache table with owner RLS`
- **Suggested commit message:** `feat(db): add mail_messages cache schema`

## Problem
Cache-first inbox (MAIL-8) needs a persistence table; defining the schema/RLS is a discrete, reviewable DB unit separate from the app wiring.

## Current behavior
No mail cache table.

## Expected behavior
A `mail_messages` table keyed by `(user_id, provider, account_email, provider_message_id)` storing headers + snippet + flags + sync columns, with strict owner RLS and a `(user_id, account_email, internal_date desc)` index. **Body caching is opt-out by default** unless DATA/privacy review approves.

## User workflow
N/A (schema).

## Why this matters
Splits the schema decision (privacy-sensitive) from the app code so it can be reviewed independently.

## Technical scope
### Files to inspect
DATA-1 manifest; an existing owner-RLS migration (e.g. `people`); `lib/crypto.ts`; DATA-5 id-map.
### Files likely to change
New numbered migration `0xx_mail_messages.sql` + RLS + indexes.
### DB impact (Supabase/Tembo)
New user-owned table. **Decide whether bodies are stored** (default: no — store headers/snippet; fetch body on open). If Tembo is the analytics/warehouse layer (DATA-7), do NOT replicate mail there (privacy). Document.
### RLS
`user_id = auth.uid()` for all ops; index FKs.
### Security/privacy
Email content is sensitive; minimize what's cached; consider encryption-at-rest for any body via `lib/crypto.ts`.

## Claude implementation prompt
Paste this into Claude:

```txt
Add the mail_messages cache table for AXIS (depends on DATA-1 ordering + DATA-5 id-map). Schema + RLS only — no app wiring (that's MAIL-8).
1. INSPECT: DATA-1 manifest, the people table migration (RLS pattern), lib/crypto.ts, DATA-5 id-map.
2. EXPLAIN: proposed columns/keys/indexes/RLS and the body-caching recommendation (default: store from/subject/snippet/internal_date/is_unread/labels + sync columns; DO NOT store body unless approved). Get the privacy call explicit.
3. IMPLEMENT a numbered migration per DATA-1's scheme: mail_messages with unique (user_id, provider, account_email, provider_message_id), owner RLS for select/insert/update/delete, index (user_id, account_email, internal_date desc). No body column unless the explanation justified it (then nullable + note encryption).
4. DO NOT wire any app code; do not push to prod without confirming ordering.
5. ACCEPTANCE: migration applies clean on a branch DB; RLS proven (second user can't read); indexes present.
6. MANUAL TEST: apply on branch DB; insert rows as user A; confirm user B sees none.
7. REGRESSION RISKS: RLS gap, wrong unique key causing dupes.
8. FINAL RESPONSE: schema SQL, RLS test result, migration filename, body-caching decision, applied-where statement.
```

## Acceptance criteria
- [ ] `mail_messages` migration exists with the documented columns, unique key, and `(user_id, account_email, internal_date desc)` index.
- [ ] Owner RLS on all operations; a second user cannot read another's rows (proven on a branch DB).
- [ ] Bodies are not stored unless the PR documents an approved privacy decision (+ encryption note).
- [ ] Migration applies cleanly under DATA-1 ordering; prod untouched unless explicitly approved.

## Manual test checklist
- [ ] 1. Apply migration on a Supabase branch. 2. Insert as user A. 3. Query as user B → zero rows. 4. Confirm index via `explain`. 5. Confirm unique key prevents dupes. 6–10. n/a UI.

## Deployment validation
- [ ] Branch DB replay succeeds. [ ] RLS test evidence in PR. [ ] Not applied to prod unless approved (state it). [ ] PR documents the body-caching decision.

---

# [P1] Data: add sync-state model

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:data` `area:integrations` `migration` `rls` `review-needed`
- **Suggested assignee type:** Review-needed
- **Estimated complexity:** S
- **Dependencies:** DATA-1
- **Blocks / blocked by:** Blocks INT-7, MAIL-8 freshness. Blocked by DATA-1.
- **Suggested branch:** `claude/data-sync-state`
- **Suggested PR title:** `feat(db): sync_state table for per-account freshness`
- **Suggested commit message:** `feat(db): add sync_state schema with owner RLS`

## Problem
No persistent record of per-account sync freshness/errors (needed by MAIL-8, INT-7).

## Expected behavior
A `sync_state` table keyed `(user_id, domain, provider, account_ref)` with `last_synced_at`, `last_status`, `last_error_code`, `cursor`, `updated_at`; owner RLS.

## Technical scope
### Files to inspect
DATA-1 manifest; INT-7 consumer expectations; INT-6 error codes (for `last_error_code` domain).
### Files likely to change
New numbered migration `0xx_sync_state.sql`.
### DB impact
New user-owned table; small; RLS owner-scoped.
### Security/RLS
`user_id = auth.uid()` all ops.

## Claude implementation prompt
Paste this into Claude:

```txt
Add a sync_state table for AXIS (depends on DATA-1). Schema + RLS only.
1. INSPECT: DATA-1 manifest, the people RLS migration, INT-6 error codes (for last_error_code values).
2. EXPLAIN: columns/keys/RLS; key = (user_id, domain, provider, account_ref); last_error_code is a free-form code from INT-6.
3. IMPLEMENT a numbered migration: sync_state with unique (user_id, domain, provider, account_ref), columns last_synced_at timestamptz, last_status text, last_error_code text null, cursor text null, updated_at; owner RLS for all ops; index (user_id, domain).
4. DO NOT wire app code (that's INT-7/MAIL-8); don't push to prod without ordering confirmation.
5. ACCEPTANCE: applies clean on branch DB; RLS proven.
6. MANUAL TEST: branch apply + RLS check.
7. REGRESSION RISKS: RLS gap.
8. FINAL RESPONSE: SQL, RLS test, filename, applied-where.
```

## Acceptance criteria
- [ ] `sync_state` migration with documented columns, unique key, owner RLS, and `(user_id, domain)` index.
- [ ] RLS proven on a branch DB (second user sees none).
- [ ] Applies cleanly under DATA-1 ordering; prod untouched unless approved.

## Manual test checklist
- [ ] 1. Apply on branch. 2. Insert as A. 3. Query as B → none. 4. Confirm unique key. 5–10. n/a.

## Deployment validation
- [ ] Branch replay succeeds. [ ] RLS evidence in PR. [ ] Not applied to prod unless approved. [ ] PR documents the schema.

---

# [P1] Data: provider object ID mapping

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:data` `area:integrations` `migration` `rls` `claude-ready`
- **Suggested assignee type:** Review-needed
- **Estimated complexity:** S
- **Dependencies:** DATA-1
- **Blocks / blocked by:** Blocks MAIL-8 (stable keys), CAL sync. Blocked by DATA-1.
- **Suggested branch:** `claude/data-provider-id-map`
- **Suggested PR title:** `feat(db): provider object id mapping table`
- **Suggested commit message:** `feat(db): add provider_object_map for stable external↔internal ids`

## Problem
Cached/synced objects (mail messages, calendar events) need a stable mapping between provider ids (which differ across Gmail/Outlook/Composio) and internal rows, especially when the same logical account is reached via different transports.

## Expected behavior
A `provider_object_map` table mapping `(user_id, domain, provider, external_id)` → internal id + metadata, owner RLS; used by MAIL-8 + calendar sync to dedupe and update in place.

## Technical scope
### Files to inspect
DATA-1 manifest; MAIL-8 cache keys; calendar event ids.
### Files likely to change
New numbered migration `0xx_provider_object_map.sql`.
### DB impact
New user-owned table; RLS owner-scoped; unique `(user_id, domain, provider, external_id)`.
### Security/RLS
`user_id = auth.uid()`.

## Claude implementation prompt
Paste this into Claude:

```txt
Add provider_object_map for AXIS (depends on DATA-1). Schema + RLS only.
1. INSPECT: DATA-1 manifest, MAIL-8 cache key needs, calendar event id shapes.
2. EXPLAIN: columns/keys/RLS; unique (user_id, domain, provider, external_id) → internal_id + json meta.
3. IMPLEMENT a numbered migration: provider_object_map (user_id, domain, provider, external_id, internal_id, meta jsonb, created_at, updated_at), unique key as above, owner RLS, index (user_id, domain, provider).
4. DO NOT wire app code; don't push to prod without ordering confirmation.
5. ACCEPTANCE: applies clean on branch; RLS proven.
6. MANUAL TEST: branch apply + RLS.
7. REGRESSION RISKS: RLS gap, missing unique constraint → dupes.
8. FINAL RESPONSE: SQL, RLS test, filename, applied-where.
```

## Acceptance criteria
- [ ] `provider_object_map` migration with the documented schema, unique key, owner RLS, index.
- [ ] RLS proven on a branch DB.
- [ ] Applies cleanly under DATA-1 ordering; prod untouched unless approved.

## Manual test checklist
- [ ] 1. Apply on branch. 2. Insert as A. 3. Query as B → none. 4. Unique key enforced. 5–10. n/a.

## Deployment validation
- [ ] Branch replay succeeds. [ ] RLS evidence in PR. [ ] Not applied to prod unless approved. [ ] PR documents schema + intended consumers.

---

# [P0] Data: confirm RLS policies for all new tables

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P0
- **Suggested status:** Backlog
- **Labels:** `area:data` `security` `rls` `review-needed`
- **Suggested assignee type:** Review-needed (security)
- **Estimated complexity:** S
- **Dependencies:** DATA-3, DATA-4, DATA-5 (and any other new tables)
- **Blocks / blocked by:** Gate for MAIL-8/INT-7 going to prod. Blocked by the new-table issues.
- **Suggested branch:** `claude/data-rls-verification`
- **Suggested PR title:** `test(db): verify RLS on all new data-layer tables`
- **Suggested commit message:** `test(db): add RLS verification for cache/sync tables`

## Problem
New tables (mail cache, sync_state, id-map) are user-owned and must never leak across users; RLS needs explicit verification, not assumption.

## Expected behavior
A repeatable RLS verification (SQL or a Supabase advisor run) proving each new table denies cross-user reads/writes; documented results. Also run `mcp__supabase__get_advisors` for security lints.

## Technical scope
### Files to inspect
The new-table migrations; existing RLS lockdown migrations (`027`, `028`, `031`, `032`).
### Files likely to change
New `docs/db/rls-verification.md` (+ optional SQL test snippets).
### DB impact
Read/verify only; may add missing policies if a gap is found (then a migration).
### Security/RLS
The whole point. Use `get_advisors` (security) + manual cross-user tests.

## Claude implementation prompt
Paste this into Claude:

```txt
Verify RLS on all new AXIS data-layer tables (mail_messages, sync_state, provider_object_map, + any others added). 
1. INSPECT: the new-table migrations; the existing RLS lockdown migrations (027/028/031/032) for the project's RLS conventions.
2. EXPLAIN: the verification method (per table: as user A insert; as user B select/update/delete → expect zero/denied) and that you'll also run the Supabase security advisor.
3. IMPLEMENT docs/db/rls-verification.md: for each new table, the test SQL + expected result; run them on a branch DB; run mcp__supabase get_advisors (security) and record findings. If any table lacks a needed policy, add a migration to fix it (per DATA-1 ordering).
4. DO NOT weaken any existing policy; don't disable RLS.
5. ACCEPTANCE: every new table proven to deny cross-user access; advisor shows no new security lints; gaps fixed via migration.
6. MANUAL TEST: the cross-user tests on a branch DB.
7. REGRESSION RISKS: a policy that blocks the legitimate owner too (test the positive case as well).
8. FINAL RESPONSE: the verification doc with results, advisor output, and any fix migration.
```

## Acceptance criteria
- [ ] Each new table has a documented cross-user denial test (B cannot read/write A's rows) that passes on a branch DB.
- [ ] The owner positive-case test (A can CRUD own rows) passes.
- [ ] `get_advisors` (security) shows no new lints for the new tables.
- [ ] Any RLS gap found is fixed via a DATA-1-ordered migration.

## Manual test checklist
- [ ] 1. Apply new-table migrations on a branch. 2. Per table: insert as A, attempt B read/update/delete → denied. 3. Confirm A can CRUD own. 4. Run security advisor. 5. Fix gaps. 6–10. n/a.

## Deployment validation
- [ ] Branch replay + RLS tests pass. [ ] Advisor clean for new tables. [ ] Any fix migration applied on branch, prod deferred unless approved. [ ] PR includes the verification doc.

---

# [P0] Data: clarify Tembo's role (inspect, do not assume)

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P0
- **Suggested status:** Todo
- **Labels:** `area:data` `area:infra` `type:chore` `needs-human`
- **Suggested assignee type:** Review-needed (Claude inspects; human confirms intent)
- **Estimated complexity:** S
- **Dependencies:** none
- **Blocks / blocked by:** Blocks DATA-8 + any decision to route sync/analytics through Tembo (MAIL-8, INT-7). Blocked by: none.
- **Suggested branch:** `claude/data-tembo-role-investigation`
- **Suggested PR title:** `docs(infra): document Tembo's actual role in AXIS`
- **Suggested commit message:** `docs(infra): record Tembo configuration findings`

## Problem
Tembo is named as an integrated service but its role is undocumented. We must not assume it is the primary Postgres, an analytics warehouse, a queue, a cache, or experimental — assuming wrong corrupts the data-layer design.

## Current behavior
No reference to Tembo found in the repo audit (no obvious client/config); its relationship to Supabase Postgres is unknown.

## Expected behavior
A short doc stating, with evidence, what Tembo is wired to (if anything): connection strings/env vars, any client lib, whether it's a separate Postgres/warehouse/queue, and a recommendation for whether AXIS sync/analytics should use it.

## User workflow
N/A.

## Why this matters
DATA-3/4/5 + MAIL-8 + INT-7 all make storage decisions; if Tembo is the warehouse, analytics-like sync data might belong there, not in Supabase — but only if confirmed.

## Technical scope
### Files to inspect
`.env.local` / `.env.local.example` (TEMBO_*/DATABASE_URL variants), `package.json` (any Tembo/pg client), `next.config.ts`, any `lib/**` db config, Vercel env (ask human), Linear/Tembo integration settings (ask human).
### Files likely to change
New `docs/infra/tembo.md`.
### DB impact
Investigation only; no schema change.
### Integration impact
Determines whether sync/analytics pipelines target Tembo.
### Security
If Tembo holds a connection string, treat as secret; never commit it.

## Claude implementation prompt
Paste this into Claude:

```txt
Investigate and document Tembo's role in AXIS. Do NOT assume — find evidence.
1. INSPECT: .env.local.example and .env.local (look for TEMBO_*, any second DATABASE_URL/POSTGRES_URL), package.json (pg/postgres/tembo clients), next.config.ts, all of src/lib for any non-Supabase Postgres client or Tembo usage. Grep the repo for "tembo" (case-insensitive).
2. EXPLAIN: what you found vs not found. If there is NO repo evidence, say so plainly and list what you'd need from the human (Vercel env, Linear↔Tembo integration purpose, whether Tembo is the Supabase-underlying Postgres or a separate instance).
3. IMPLEMENT docs/infra/tembo.md: findings (with file/line evidence), the unknowns, and a recommendation: until confirmed, treat Supabase Postgres as primary for all user data; do NOT route sync/cache to Tembo. Add explicit questions for the human.
4. DO NOT add a Tembo client, change DB config, or route any data to Tembo.
5. ACCEPTANCE: doc states evidence-based findings + a clear "confirmed/unknown" verdict + questions for the human; no code/config changed.
6. MANUAL TEST: re-grep to confirm completeness.
7. REGRESSION RISKS: none (docs) — but DO NOT leak any secret value into the doc.
8. FINAL RESPONSE: the findings doc + an explicit list of questions the human must answer before DATA-8.
```

## Acceptance criteria
- [ ] `docs/infra/tembo.md` records evidence-based findings (with file/line refs) on whether/how Tembo is wired.
- [ ] States a clear verdict: confirmed role, or "unknown — needs human confirmation" with specific questions.
- [ ] Recommends Supabase-primary until Tembo's role is confirmed; no data routed to Tembo.
- [ ] No secret values committed; no code/config changed.

## Manual test checklist
- [ ] 1. Grep repo for `tembo`. 2. Inspect env + package.json + lib. 3. Write findings. 4. List human questions. 5. Re-grep to confirm. 6–10. n/a.

## Deployment validation
- [ ] No build impact. [ ] No migration. [ ] No secrets committed. [ ] PR tags the human for the open questions.

---

# [P1] Data: do not assume Tembo role — wire only after confirmation

## Linear metadata
- **Project:** Data Layer + Sync Architecture
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:data` `area:infra` `needs-human`
- **Suggested assignee type:** Human (decision) → Claude (implementation once decided)
- **Estimated complexity:** S (decision) / M (if wiring follows)
- **Dependencies:** DATA-7
- **Blocks / blocked by:** Gates any Tembo-targeted pipeline. Blocked by DATA-7 + human answer.
- **Suggested branch:** `claude/data-tembo-decision`
- **Suggested PR title:** `docs(infra): Tembo role decision + integration plan`
- **Suggested commit message:** `docs(infra): record Tembo decision and integration boundary`

## Problem
Even after inspection, the decision of *whether to use* Tembo (and for what) is the human's; this issue captures that decision and, only if "yes," scopes the wiring as a follow-up.

## Current behavior
Undecided.

## Expected behavior
A recorded decision (primary PG / analytics / queue / cache / experimental / not used) and, if used, a precise boundary: which data classes go to Tembo vs Supabase, with RLS/privacy implications. No mail/PII to an analytics store without explicit approval.

## Technical scope
### Files to inspect
`docs/infra/tembo.md` (DATA-7), the human's answers.
### Files likely to change
`docs/infra/tembo.md` (decision section); follow-up issue created if wiring is approved.
### DB/integration impact
Defines the storage boundary for all sync/analytics work.
### Security
Privacy classification of any data sent to Tembo.

## Claude implementation prompt
Paste this into Claude (only after the human answers DATA-7's questions):

```txt
Record the Tembo decision for AXIS (run only after the human has answered DATA-7's questions).
1. INSPECT: docs/infra/tembo.md and the human's answers (paste them in).
2. EXPLAIN: summarize the decision in one paragraph.
3. IMPLEMENT: append a "Decision" section to docs/infra/tembo.md: chosen role; data-class boundary (what may/may not go to Tembo); privacy/RLS notes (NO mail bodies/PII to an analytics store without explicit sign-off); and either "no wiring needed" or a checklist for a follow-up wiring issue (with env vars + client lib).
4. DO NOT wire Tembo in this issue; that's a separate, scoped issue if approved.
5. ACCEPTANCE: decision recorded with a clear data boundary; follow-up issue scoped if applicable.
6. MANUAL TEST: n/a.
7. REGRESSION RISKS: none (docs).
8. FINAL RESPONSE: the decision section + the scoped follow-up issue (if any).
```

## Acceptance criteria
- [ ] `docs/infra/tembo.md` has a Decision section naming Tembo's role and the exact data-class boundary.
- [ ] Explicit privacy rule: no mail/PII to a Tembo analytics store without sign-off.
- [ ] If wiring is approved, a scoped follow-up issue is drafted (env vars, client, boundaries); otherwise "not used" is recorded.

## Manual test checklist
- [ ] 1. Read DATA-7 + human answers. 2. Write decision. 3. Draft follow-up if needed. 4–10. n/a.

## Deployment validation
- [ ] No build/migration impact. [ ] No data routed to Tembo in this issue. [ ] PR references the human decision.

---
---

# PROJECT 6 — Production Hardening

Make AXIS safe and predictable to deploy: validated config, verified Sentry, a deploy checklist, a branch/PR workflow, a smoke test, structured API errors, and graceful degradation when a provider is unconfigured. Audit refs: A6, A7, I1/I2 (degradation), the silent-failure theme.

---

# [P1] Prod: central environment variable validation

## Linear metadata
- **Project:** Production Hardening
- **Priority:** P1
- **Suggested status:** Todo
- **Labels:** `area:infra` `security` `type:feature` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** none
- **Blocks / blocked by:** Supports PROD-7. Blocked by: none.
- **Suggested branch:** `claude/prod-env-validation`
- **Suggested PR title:** `feat(infra): central env var validation with zod`
- **Suggested commit message:** `feat(infra): validate + type environment variables`

## Problem
Env vars are read ad hoc (`process.env.X`) across ~90 routes; a missing/typo'd var fails deep in a request (or silently degrades) instead of at boot, and there's no single source of which vars are required vs optional.

## Current behavior
Each route reads `process.env` directly; `next.config.ts` doesn't validate; the README env table is partial/stale (A6).

## Expected behavior
A `lib/env.ts` (zod-validated) that declares every env var (required vs optional, with which feature each gates), parsed once; routes import typed `env`. Optional integration keys (Polygon, Plaid, Public.com, Gemini, Anthropic, health client ids) are typed optional so absence → graceful degradation (PROD-7), not a crash.

## User workflow
N/A; improves reliability + onboarding.

## Why this matters
Turns "why is this 500ing in prod?" into a clear boot/log-time message; documents the real env surface (fixes part of A6).

## Technical scope
### Files to inspect
`grep -r "process.env" src` (full surface), `.env.local.example`, `next.config.ts`, `lib/ai/router.ts` (optional keys), provider `_lib.ts` files.
### Files likely to change
New `src/lib/env.ts`; high-traffic routes import it; `.env.local.example` updated to match; README env table (A6 overlap).
### API routes
No contract change; safer reads.
### DB impact
None. No migration.
### Integration impact
Documents which keys gate which integrations (Composio, Polygon, Plaid, Public, Gemini, Anthropic, Upstash, Sentry, health ids).
### Security
Never log secret values; validate presence/shape only. Keep server-only vars out of `NEXT_PUBLIC_`.
### Error handling
Missing required var → explicit error at first use with the var name; missing optional → feature-disabled path.

## Claude implementation prompt
Paste this into Claude:

```txt
Add central env validation to AXIS.
1. INSPECT: grep all process.env usages across src; read .env.local.example, next.config.ts, lib/ai/router.ts, the provider _lib.ts files. Classify each var required vs optional and which feature it gates.
2. EXPLAIN: a table of every env var → required/optional → feature gated → server-only?.
3. IMPLEMENT src/lib/env.ts using zod: a schema with required vars (Supabase URL/anon key) and optional integration keys; parse once; export a typed `env`. Refactor the highest-traffic / most fragile routes to import env instead of raw process.env (don't churn all 90 in one go — do the core: supabase clients, ai router, massive, plaid, composio). Update .env.local.example to be complete. Do NOT throw at import for OPTIONAL vars — only required ones, and with a clear message naming the var.
4. DO NOT move server-only vars to NEXT_PUBLIC_; don't log secret values; don't change response shapes.
5. ACCEPTANCE: missing a required var fails fast with the var name; missing optional vars degrade gracefully; .env.local.example complete; tsc clean.
6. MANUAL TEST: unset an optional key (e.g. POLYGON) → feature degrades, no crash; (locally) blank a required var → clear error.
7. REGRESSION RISKS: accidentally marking an optional var required (breaks degraded deploys), exposing a server var to the client.
8. FINAL RESPONSE: the env table, env.ts, routes refactored, checklist, tsc result.
```

## Acceptance criteria
- [ ] `lib/env.ts` validates env via zod; required vs optional clearly modeled; one parse.
- [ ] Core fragile paths (supabase clients, AI router, massive, plaid, composio) read typed `env`.
- [ ] Missing a required var fails fast naming the var; missing optional keys degrade (no crash).
- [ ] `.env.local.example` lists every var with required/optional + purpose.
- [ ] No server-only var exposed via `NEXT_PUBLIC_`; no secret values logged. `tsc` clean.

## Manual test checklist
- [ ] 1. `npm run dev`. 2. Unset `POLYGON_API_KEY`/`MASSIVE_API_KEY` → Fund quotes degrade gracefully (status shows not-configured), no crash. 3. Unset `GEMINI_API_KEY` → AI falls back per router. 4. (Locally) blank `NEXT_PUBLIC_SUPABASE_URL` → clear startup error naming it; restore. 5. App boots with full env. 6. Vercel preview builds. 7. n/a refresh. 8. Preview behaves. 9. No new Sentry error. 10. Mail/Fund still work with full env.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No new Sentry error (happy). [ ] No migration. [ ] PR includes the env table + confirms Vercel env parity.

---

# [P1] Prod: Sentry configuration verification

## Linear metadata
- **Project:** Production Hardening ∩ Latency + Observability
- **Priority:** P1
- **Suggested status:** Todo
- **Labels:** `area:infra` `observability` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** S
- **Dependencies:** none
- **Blocks / blocked by:** Supports all Sentry-dependent acceptance criteria. Blocked by: none.
- **Suggested branch:** `claude/prod-sentry-verification`
- **Suggested PR title:** `chore(observability): verify + harden Sentry config`
- **Suggested commit message:** `chore(observability): confirm Sentry client/server/edge wiring`

## Problem
Many issues' "Done" depends on "no new Sentry error" — but Sentry's wiring (DSN, environments, source maps, PII scrubbing, sample rates) hasn't been verified end-to-end.

## Current behavior
`sentry.{client,server,edge}.config.ts` exist; `@sentry/nextjs` installed; actual capture/environment/PII behavior unverified.

## Expected behavior
Confirmed: DSN set per environment (preview vs prod), errors captured client+server+edge, releases/source maps wired in `next.config.ts`, PII scrubbed (no tokens/emails/bodies), sensible `tracesSampleRate`. A documented "how to verify Sentry" note + a deliberate test error path.

## Technical scope
### Files to inspect
`sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `next.config.ts` (withSentryConfig), `app/error.tsx`, `app/global-error.tsx`.
### Files likely to change
The sentry configs (env-gated DSN, `beforeSend` PII scrub, sample rates); a `docs/observability/sentry.md`.
### API/DB impact
None. No migration.
### Integration impact
Sentry only.
### Security
`beforeSend`/`beforeSendTransaction` must strip auth headers, cookies, tokens, emails, mail bodies.
### Performance
Reasonable sample rate (e.g. 0.1 traces) to control cost.

## Claude implementation prompt
Paste this into Claude:

```txt
Verify and harden AXIS Sentry configuration.
1. INSPECT: sentry.{client,server,edge}.config.ts, next.config.ts (withSentryConfig + source maps), app/error.tsx, app/global-error.tsx. Check env-gating of DSN and any PII scrubbing.
2. EXPLAIN: current config gaps (env separation, PII scrub, sample rate, source maps).
3. IMPLEMENT: env-gated DSN (skip in dev unless explicitly enabled), beforeSend that strips cookies/authorization/tokens/emails/mail bodies, a modest tracesSampleRate, and confirm withSentryConfig uploads source maps in prod builds. Add docs/observability/sentry.md describing how to trigger + verify a test event and what's scrubbed.
4. DO NOT spam Sentry from dev by default; don't capture PII; don't change app logic.
5. ACCEPTANCE: a deliberate server + client error appears in Sentry with readable stack (source maps) and NO PII; dev is quiet unless enabled.
6. MANUAL TEST: throw a test error server-side and client-side on a preview; confirm both in Sentry, scrubbed.
7. REGRESSION RISKS: leaking PII, over-sampling cost, breaking the build with source-map config.
8. FINAL RESPONSE: config diffs, the verification doc, Sentry event links (redacted), build result.
```

## Acceptance criteria
- [ ] DSN is environment-gated (dev quiet unless explicitly enabled; preview + prod separated).
- [ ] `beforeSend` strips cookies/authorization/tokens/emails/mail bodies (verified on a real event).
- [ ] Client, server, and edge errors are captured with source-mapped stacks in prod/preview builds.
- [ ] `tracesSampleRate` is set to a sane value; documented in `docs/observability/sentry.md`.
- [ ] `next build` succeeds with source-map upload configured.

## Manual test checklist
- [ ] 1. Trigger a server error on preview → appears in Sentry, scrubbed, source-mapped. 2. Trigger a client error → same. 3. Confirm dev does not send by default. 4. Inspect an event payload → no PII. 5. Confirm sample rate. 6. Preview build OK. 7. n/a. 8. Preview behaves. 9. Confirm happy paths are silent. 10. error.tsx/global-error.tsx still render.

## Deployment validation
- [ ] Vercel preview build succeeds (source maps). [ ] Test events visible + scrubbed. [ ] No migration. [ ] PR links redacted Sentry events + the doc.

---

# [P1] Prod: Vercel deployment checklist

## Linear metadata
- **Project:** Production Hardening
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:infra` `type:chore` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** XS
- **Dependencies:** PROD-1, PROD-2
- **Blocks / blocked by:** Referenced by every issue's deploy section. Blocked by PROD-1/2.
- **Suggested branch:** `claude/prod-vercel-checklist`
- **Suggested PR title:** `docs(infra): Vercel deployment + preview checklist`
- **Suggested commit message:** `docs(infra): add deploy checklist`

## Problem
No canonical deploy checklist; env parity (local↔preview↔prod), migration application, and cron config are easy to forget (e.g. the orphaned crons I2).

## Expected behavior
`docs/infra/deploy-checklist.md`: pre-merge (tsc, build, env parity, migrations applied/ordered, Sentry env), preview validation, prod promotion (cron config incl. the two orphaned crons I2, env vars present), and rollback steps.

## Technical scope
### Files to inspect
`vercel.json` (crons, regions), `next.config.ts`, `.env.local.example`, `.github/workflows/*`, audit I2.
### Files likely to change
New `docs/infra/deploy-checklist.md`.
### Impact
Docs only. No migration.

## Claude implementation prompt
Paste this into Claude:

```txt
Write docs/infra/deploy-checklist.md for AXIS.
1. INSPECT: vercel.json (crons/regions), next.config.ts, .env.local.example, .github/workflows, and audit finding I2 (feed-digest + intelligence-sweep crons are unscheduled).
2. EXPLAIN: outline the checklist sections first.
3. IMPLEMENT the doc: Pre-merge (npx tsc --noEmit, next build, env parity local↔Vercel, migrations ordered+applied per DATA-1, Sentry env set); Preview validation (preview URL happy+error paths, no new Sentry error); Prod promotion (all required env vars in Vercel, cron entries present — explicitly list daily, finance-daily, AND flag feed-digest + intelligence-sweep as needing wiring per I2); Rollback (revert deploy, revert migration caveats). 
4. DO NOT change vercel.json here (that's a separate issue) — just document the gap.
5. ACCEPTANCE: checklist is concrete + includes the cron gap + migration + env parity + rollback.
6. MANUAL TEST: dry-run the checklist against the current main deploy.
7. REGRESSION RISKS: none (docs).
8. FINAL RESPONSE: the doc + a note that I2 crons remain unscheduled (needs a follow-up infra issue).
```

## Acceptance criteria
- [ ] `docs/infra/deploy-checklist.md` covers pre-merge, preview validation, prod promotion, and rollback.
- [ ] Explicitly lists required env vars (from PROD-1) and migration-ordering checks (DATA-1).
- [ ] Flags the unscheduled `feed-digest` + `intelligence-sweep` crons (I2) as a promotion gap.
- [ ] Dry-run once against the current deploy.

## Manual test checklist
- [ ] 1. Open doc. 2. Run pre-merge steps locally. 3. Validate against a preview. 4. Confirm cron gap noted. 5. Confirm env list matches PROD-1. 6–10. n/a.

## Deployment validation
- [ ] Build unaffected. [ ] No migration. [ ] PR links the doc + a follow-up issue for the cron wiring.

---

# [P2] Prod: GitHub branch/PR workflow convention

## Linear metadata
- **Project:** Production Hardening
- **Priority:** P2
- **Suggested status:** Backlog
- **Labels:** `area:infra` `type:chore` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** XS
- **Dependencies:** none
- **Blocks / blocked by:** none.
- **Suggested branch:** `claude/prod-github-workflow`
- **Suggested PR title:** `docs(infra): branch/PR convention + PR template`
- **Suggested commit message:** `docs(infra): add PR template and contribution conventions`

## Problem
No PR template/convention to enforce the per-issue evidence (preview URL, checklist, Sentry, migration status) this plan requires; Linear auto-linking depends on branch naming.

## Expected behavior
A `.github/pull_request_template.md` capturing: linked Linear issue, summary, test evidence (manual checklist + preview URL), migration status, Sentry status, screenshots; plus `docs/infra/contributing.md` documenting branch naming (`claude/<area>-<slug>` / `<initials>/AX-<n>-<slug>`), conventional commits, and the Co-Authored-By footer.

## Technical scope
### Files to inspect
`.github/` (existing workflows), this plan's metadata conventions.
### Files likely to change
New `.github/pull_request_template.md`, `docs/infra/contributing.md`.
### Impact
Docs/config only. No migration.

## Claude implementation prompt
Paste this into Claude:

```txt
Add a PR template + contribution conventions for AXIS.
1. INSPECT: .github/ contents; this plan's "Toolchain contract" + per-issue metadata.
2. EXPLAIN: the required PR evidence fields.
3. IMPLEMENT: .github/pull_request_template.md with sections: Linked Linear issue, Summary, Manual test checklist (pasted results), Vercel preview URL, Migration status (applied/ordered/not required), Sentry status (no new error on happy path), Screenshots, Risk/rollback. Add docs/infra/contributing.md: branch naming, conventional commits, the Claude/Human/Review labels, and the Co-Authored-By footer.
4. DO NOT change CI workflows here.
5. ACCEPTANCE: template + conventions match this plan's requirements.
6. MANUAL TEST: open a draft PR and confirm the template renders.
7. REGRESSION RISKS: none.
8. FINAL RESPONSE: the two files + a screenshot of the rendered template.
```

## Acceptance criteria
- [ ] `.github/pull_request_template.md` requires linked issue, test evidence, preview URL, migration status, Sentry status, screenshots, rollback.
- [ ] `docs/infra/contributing.md` documents branch naming, conventional commits, label conventions, and the Co-Authored-By footer.
- [ ] A draft PR renders the template correctly.

## Manual test checklist
- [ ] 1. Add files. 2. Open a draft PR → template renders. 3. Confirm fields match plan. 4–10. n/a.

## Deployment validation
- [ ] No build/migration impact. [ ] PR uses the new template itself (dogfood).

---

# [P1] Prod: Playwright smoke tests for Mail

## Linear metadata
- **Project:** Production Hardening ∩ Latency + Observability
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:mail` `type:test` `claude-ready`
- **Suggested assignee type:** Review-needed (test infra choice)
- **Estimated complexity:** M
- **Dependencies:** MAIL-1 (something to assert), PROD-1
- **Blocks / blocked by:** Blocked by MAIL-1. First test harness for the repo (A7).
- **Suggested branch:** `claude/prod-playwright-mail-smoke`
- **Suggested PR title:** `test(mail): Playwright smoke tests for the mail slice`
- **Suggested commit message:** `test(mail): add Playwright smoke + CI wiring`

## Problem
Audit A7: zero automated tests. Mail is the most fragile slice; it needs a smoke test that runs on preview/CI to catch the MAIL-1-class regression (rows that don't open).

## Expected behavior
Playwright smoke covering: login (test user), `/mail` loads, an inbox row opens into `MessagePanel` with subject/sender/date/body, a forced-error path shows the error state, and refresh persists. Runs in CI against a preview or a seeded test env; provider calls mocked where a live account isn't available.

## Technical scope
### Files to inspect
`package.json` (scripts/deps), `MailModule.tsx`/`MessagePanel.tsx` (stable selectors/test ids), `.github/workflows/`, PROD-1 env.
### Files likely to change
Add `@playwright/test`; `playwright.config.ts`; `e2e/mail.spec.ts`; test-id attributes in mail components; a CI job; `package.json` `test:e2e` script.
### API/DB impact
Test user + possibly a mock server for provider responses. No app migration (may need a seeded test account — document).
### Integration impact
Mock Composio/direct responses for deterministic runs; optionally a "live smoke" tag for a real connected account.
### Security
Test credentials via CI secrets only; never commit.
### Performance
Keep smoke fast (< ~2 min).

## Claude implementation prompt
Paste this into Claude:

```txt
Add Playwright smoke tests for AXIS Mail (first tests in the repo; depends on MAIL-1, PROD-1).
1. INSPECT: package.json, MailModule.tsx + MessagePanel.tsx (add stable data-testid where needed), .github/workflows, how auth/login works (login/page.tsx), and whether a test user exists.
2. EXPLAIN: the test strategy — auth approach (test user via env), and how you'll make provider responses deterministic (mock /api/mail/inbox + /api/mail/message/[id] via route interception, plus an optional @live tag).
3. IMPLEMENT: add @playwright/test + playwright.config.ts; e2e/mail.spec.ts covering: login, /mail loads, clicking a (mocked) Composio Gmail row opens MessagePanel with subject/sender/date/body, forced 502 shows error+retry, refresh persists; add data-testid attributes minimally; add a CI job (GitHub Actions) running against the build; add npm script test:e2e.
4. DO NOT test live external accounts in the default run (mock); don't commit credentials; keep changes scoped to test infra + minimal testids.
5. ACCEPTANCE: test:e2e passes locally + in CI; asserts the MAIL-1 happy path + error path; deterministic.
6. MANUAL TEST: run test:e2e locally; break MAIL-1 intentionally → test fails (proves it guards the regression).
7. REGRESSION RISKS: flaky selectors (use testids), CI auth setup.
8. FINAL RESPONSE: files added, how to run, CI job, a note proving the test catches a reverted MAIL-1.
```

## Acceptance criteria
- [ ] `@playwright/test` + `playwright.config.ts` + `e2e/mail.spec.ts` + `test:e2e` script added.
- [ ] Smoke asserts: login → `/mail` loads → row opens `MessagePanel` (subject/sender/date/body) → forced error shows error+retry → refresh persists.
- [ ] Runs deterministically with mocked provider responses; optional `@live` variant documented.
- [ ] A CI job runs `test:e2e`; reverting MAIL-1 makes the test fail.
- [ ] No credentials committed; `tsc` clean.

## Manual test checklist
- [ ] 1. `npm run test:e2e` locally → passes. 2. Temporarily revert MAIL-1 → test fails. 3. Restore → passes. 4. CI job runs on the PR. 5. Confirm no live provider hit in default run. 6. Preview build OK. 7. n/a. 8. CI green. 9. No PII in test artifacts. 10. App unaffected.

## Deployment validation
- [ ] CI runs `test:e2e` green. [ ] Vercel preview build succeeds. [ ] No migration (note any seeded test user). [ ] PR shows the test failing on a reverted MAIL-1.

---

# [P1] Prod: API route structured errors (standard envelope)

## Linear metadata
- **Project:** Production Hardening ∩ Latency + Observability
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:infra` `observability` `type:refactor` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** M
- **Dependencies:** INT-6 (provider error codes)
- **Blocks / blocked by:** Improves every UI error state. Blocked by INT-6.
- **Suggested branch:** `claude/prod-api-structured-errors`
- **Suggested PR title:** `feat(api): standard error envelope + helper`
- **Suggested commit message:** `feat(api): unify API error responses`

## Problem
API routes return inconsistent error shapes (`{error}` vs `{message}` vs bare status), so the UI can't reliably render specific messages, and Sentry context is uneven.

## Expected behavior
A `jsonError(code, message, status, ctx?)` helper producing `{ error: { code, message } }`, used by core routes; pairs with INT-6 provider codes; captures to Sentry consistently. The client gets predictable error envelopes.

## Technical scope
### Files to inspect
A sample of `app/api/**/route.ts` (mail, fund, calendar, ai), `lib/integrations/errors.ts` (INT-6).
### Files likely to change
New `lib/api/respond.ts` (`jsonError`/`jsonOk`); refactor core routes (mail, integrations, fund, ai) to use it. Don't churn all 90 at once — do the high-value ones.
### API routes
Core routes standardized (additive `code` field; keep existing top-level `error` string for back-compat where the UI reads it, or update the few consumers).
### DB impact
None. No migration.
### Observability
Centralized Sentry capture in the helper for 5xx.
### Security
No PII/stack in client error messages.

## Claude implementation prompt
Paste this into Claude:

```txt
Standardize AXIS API error responses (depends on INT-6).
1. INSPECT: 8-10 representative app/api routes (mail, fund, calendar, ai, integrations), and lib/integrations/errors.ts.
2. EXPLAIN: the current variety of error shapes and which client components read which field.
3. IMPLEMENT lib/api/respond.ts: jsonError(code, message, status, ctx?) → NextResponse.json({error:{code,message}}, {status}) and jsonOk(data). For 5xx, capture to Sentry with code+route tags (no PII). Refactor the core mail/integrations/fund/ai routes to use it; where the client currently reads a top-level `error` string, update those few consumers to read error.message (or keep both fields for back-compat — choose and be consistent).
4. DO NOT refactor all 90 routes; don't break existing client error rendering (update consumers you change).
5. ACCEPTANCE: refactored routes return {error:{code,message}}; UI still shows correct messages; 5xx captured to Sentry.
6. MANUAL TEST: force errors on refactored routes; confirm UI messages + Sentry.
7. REGRESSION RISKS: client reading old error shape → broken message; over-capturing expected 4xx.
8. FINAL RESPONSE: helper API, routes refactored, consumers updated, checklist, tsc result.
```

## Acceptance criteria
- [ ] `lib/api/respond.ts` provides `jsonError`/`jsonOk`; core mail/integrations/fund/ai routes use it.
- [ ] Error envelope is `{ error: { code, message } }`; any UI consumer of changed routes reads the new shape correctly.
- [ ] 5xx responses are captured to Sentry with `code` + route tags; expected 4xx are not error-spammed.
- [ ] No PII/stack leaked to clients. `tsc` clean.

## Manual test checklist
- [ ] 1–2 standard. 3. Force a 500 on a refactored route → UI shows a clean message + Sentry event. 4. Force a 4xx → correct UI message, no error-spam in Sentry. 5. Confirm changed client consumers render. 6. Preview. 7. n/a. 8. Preview behaves. 9. Happy paths silent in Sentry. 10. Unrefactored routes still work.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] Sentry captures 5xx with tags; happy path silent. [ ] No migration. [ ] PR lists refactored routes + updated consumers.

---

# [P1] Prod: missing-provider graceful degradation

## Linear metadata
- **Project:** Production Hardening ∩ Integration Health + Control Room
- **Priority:** P1
- **Suggested status:** Backlog
- **Labels:** `area:integrations` `area:ux` `type:feature` `claude-ready`
- **Suggested assignee type:** Claude
- **Estimated complexity:** M
- **Dependencies:** PROD-1, INT-1
- **Blocks / blocked by:** Resolves UI half of I1 (health "coming soon"). Blocked by PROD-1/INT-1.
- **Suggested branch:** `claude/prod-graceful-degradation`
- **Suggested PR title:** `feat(integrations): honest unconfigured/disabled states`
- **Suggested commit message:** `feat(integrations): graceful degradation for unconfigured providers`

## Problem
When a provider key/route is missing, AXIS sometimes promises data it can't deliver (audit I1 health "coming soon"; Fund cash-flow/brokerage when keys absent). Some paths crash or spin instead of showing an honest disabled state.

## Current behavior
Health devices show "coming soon" but still call a 501 route (I1); Fund features depend on Plaid/Public being configured with mixed messaging.

## Expected behavior
Each integration surface reads its configured/enabled state (from PROD-1 env + INT-1 registry) and renders an honest state: **Enabled** (works), **Not configured** (clear "add X to enable" + no dead calls), or **Planned** (health devices, gated, no live 501 call). No feature promises data it can't deliver.

## Technical scope
### Files to inspect
`VitalityModule.tsx` (health devices, `handleConnect` → 501), Fund spending/cashflow/order-ticket states, `brokerage/status`, `plaid/status`, `massive/status`, INT-1 registry, PROD-1 env.
### Files likely to change
`VitalityModule.tsx` (gate health devices to "Planned", stop the live 501 call), Fund components (consistent "Not configured" states), a small shared `IntegrationState` helper.
### API routes
Consume `*/status` routes; no new contracts.
### DB impact
None. No migration.
### Integration impact
Encodes which providers are live vs planned vs not-configured (registry/env).
### Observability
Don't Sentry-spam expected "not configured" states.

## Claude implementation prompt
Paste this into Claude:

```txt
Add honest graceful-degradation states to AXIS integrations (depends on PROD-1 env, INT-1 registry).
1. INSPECT: VitalityModule.tsx (HEALTH_DEVICES, handleConnect calling /api/health/<id>/connect which 501s — finding I1), Fund spending/cashflow/order-ticket + brokerage/status + plaid/status + massive/status, INT-1 registry, PROD-1 env.
2. EXPLAIN: for each integration surface, its three possible states (enabled / not-configured / planned) and which signal determines it.
3. IMPLEMENT: a tiny helper to resolve integration state from registry+env+status; render: health devices as "Planned" (no live connect call — remove the 501 round-trip; show a waitlist/coming-soon that doesn't pretend to connect); Fund Plaid/Public features as "Not configured — add <KEY> to enable" with no dead calls; keep enabled paths unchanged.
4. DO NOT build the health OAuth (separate effort); don't remove features that work; don't Sentry-capture expected not-configured states.
5. ACCEPTANCE: no surface promises data it can't deliver; unconfigured features show a clear enable path; health devices no longer fire a 501.
6. MANUAL TEST: with keys absent, each surface shows the honest state and makes no failing call; with keys present, works.
7. REGRESSION RISKS: hiding a feature that actually works; mislabeling configured as not-configured.
8. FINAL RESPONSE: the state table, edits, checklist, tsc result.
```

## Acceptance criteria
- [ ] Health devices render a "Planned" state and no longer fire the 501 `/api/health/*/connect` call (I1 UI half resolved).
- [ ] Fund Plaid/Public/Polygon-dependent features show a clear "Not configured — add <KEY>" state when keys are absent, with no dead/failing calls.
- [ ] Enabled integrations behave unchanged when configured.
- [ ] Expected not-configured states are not captured as Sentry errors.
- [ ] `tsc` clean.

## Manual test checklist
- [ ] 1. `npm run dev` with optional keys unset. 2. Vitality → health devices show "Planned", clicking does not fire a 501 (check network). 3. Fund spending/cashflow/order → "Not configured" with enable hint, no failing calls. 4. Set keys → features enable. 5. Refresh persists state. 6. Preview. 7. n/a. 8. Preview behaves. 9. No Sentry error for not-configured. 10. Working integrations unaffected.

## Deployment validation
- [ ] Vercel preview succeeds. [ ] No Sentry error for not-configured states. [ ] No migration. [ ] PR shows each surface's honest state with and without keys.

---
---

# BACKLOG — remaining projects (creatable now, expand to full template when scheduled)

These issues are scoped for one Claude session each and follow the same template as above. They're listed in backlog form (metadata + tight scope + headline acceptance) so they can be created in Linear immediately and expanded (full Product/Technical/Claude-prompt sections) when pulled into a milestone. Each inherits the **Toolchain contract** and the standard 10-step manual checklist + deployment-validation block.

---

## PROJECT 2 — Calendar + Agenda Slice
*Audit refs: A2, I3, U2, L2. Mirror the Mail slice for calendar, then make Agenda consume real calendar/task data.*

### [P1] CAL-1 — Calendar event detail opens into a readable, editable panel
- Project: Calendar + Agenda Slice · Complexity: M · Assignee: Claude · Deps: INT-1 · Branch: `claude/cal-event-detail` · PR: `feat(calendar): event detail panel with edit`
- **Scope:** Clicking a `schedule_events` row or external (Composio) event opens a detail panel (title, time, location, attendees, description); edit persists via `/api/calendar/event/[id]` for owned events. Mirror MAIL-1's `via`-aware fetch for Composio events.
- **Headline acceptance:** Clicking an event opens detail with all fields; editing an owned event persists + survives refresh; Composio + owned events both open; failures show a visible error.

### [P1] CAL-2 — Calendar create/update parity across Composio + owned events
- Complexity: M · Assignee: Review-needed · Deps: INT-1, CAL-1 · Branch: `claude/cal-create-update-parity` · PR: `feat(calendar): create/update parity`
- **Scope:** `/api/calendar/sync` create + a new update path work for both Google/Outlook via Composio and local `schedule_events`; `lib/calendar/index.ts` owns provider dispatch (parallels MAIL-4).
- **Headline acceptance:** Create + update succeed on both paths with success/error feedback; routes contain no provider names; conflicts surfaced via `/api/calendar/conflicts`.

### [P1] CAL-3 — Calendar cache-first + sync-state
- Complexity: L · Assignee: Review-needed · Deps: DATA-3-style cache, DATA-4, DATA-5, INT-7 · Branch: `claude/cal-cache-first` · PR: `feat(calendar): cache-first external events`
- **Scope:** Persist external events to a cache table (new migration, owner RLS) + serve cache-first with background revalidate; surface freshness. Parallels MAIL-8.
- **Headline acceptance:** Schedule first paint from cache (no network); RLS proven; per-account sync errors visible; bodies/attendee PII handled per privacy review.

### [P1] CAL-4 — Agenda consumes real calendar + task data (today/this-week)
- Complexity: M · Assignee: Claude · Deps: CAL-1, `useTasks`, `usePeople` · Branch: `claude/agenda-real-data` · PR: `feat(agenda): ranked agenda from tasks + calendar + follow-ups`
- **Scope:** Agenda merges today's events, due tasks, and People follow-ups into one ranked list with complete/route actions; remove any placeholder ranking.
- **Headline acceptance:** Agenda shows real events+tasks+follow-ups ranked; completing a task persists; routing to a module works; empty/loading/error states present.

### [P2] CAL-5 — Calendar Sentry instrumentation + error states
- Complexity: S · Assignee: Claude · Deps: INT-6, CAL-1 · Branch: `claude/cal-observability` · PR: `feat(observability): calendar provider failure capture`
- **Scope:** Parallels MAIL-9 for calendar ops (list/create/update/delete/sync); visible error+retry on detail/create.
- **Headline acceptance:** Forced calendar failures produce tagged Sentry events (no PII); UI shows error+retry; happy path silent.

---

## PROJECT 4 — Dispatch + Command Center
*Audit refs: U1, A8, the routing spine. Harden the strongest feature and make Console a real command center.*

### [P1] DISP-1 — Dispatch routing reliability + visible failures
- Complexity: M · Assignee: Claude · Deps: `useSignals`, `useSignalRoutes` · Branch: `claude/dispatch-routing-reliability` · PR: `fix(dispatch): reliable routing with visible errors`
- **Scope:** Audit the Signals→Task/Person/Note/Literature routes for silent failures; ensure each route action persists, dedupes (e.g. `usePeople.normalizeName`), and shows success/error toasts; AI triage fallback visible.
- **Headline acceptance:** Each route action persists to the right table + shows feedback; duplicate person detection works; a failed route never silently drops the signal.

### [P2] DISP-2 — Console widgets click into their module
- Complexity: S · Assignee: Claude · Deps: none · Branch: `claude/console-widget-drilldowns` · PR: `feat(console): make widgets navigable`
- **Scope (U1):** Make agenda/markets/run/weather/air widgets navigate to `/agenda`, `/fund/market`, `/vitality`, etc.; keyboard-accessible.
- **Headline acceptance:** Clicking each data widget routes to its module; focus-visible + aria; no dead tiles.

### [P3] DISP-3 — Retire duplicate routes (`/console`→`/command`, `/signals`→`/dispatch`)
- Complexity: XS · Assignee: Claude · Deps: none · Branch: `claude/retire-duplicate-routes` · PR: `chore(routing): redirect legacy duplicate routes`
- **Scope (A8):** Replace the duplicate page components with `redirect()` to the canonical nav routes.
- **Headline acceptance:** `/console` and `/signals` 308-redirect to `/command` and `/dispatch`; no module renders twice; nav unaffected.

### [P2] DISP-4 — Command palette + quick-search coverage audit
- Complexity: S · Assignee: Claude · Deps: none · Branch: `claude/command-palette-coverage` · PR: `feat(command): complete palette action coverage`
- **Scope:** Ensure ⌘K palette + `/api/search/quick` reach every nav route + core create actions (new note/task/signal); fix any dead entries.
- **Headline acceptance:** Every nav route + core create action is reachable from ⌘K; quick-search returns results across modules; no dead commands.

---

## PROJECT 5 — Latency + Observability
*Audit refs: L1, L3, L4, L5. (MAIL-8/9, INT-3/6, PROD-2/6 also contribute.)*

### [P1] OBS-1 — Console cache-first widget loading
- Complexity: L · Assignee: Review-needed · Deps: DATA-1 · Branch: `claude/console-widget-cache` · PR: `feat(console): cache-first widget data`
- **Scope (L1):** Add a widget cache (table or `feed_cache` reuse) + a batched `/api/widgets/batch`; serve cached instantly, revalidate in background; keep the geo-refetch behavior.
- **Headline acceptance:** Console renders cached widget values <200ms with no network on first paint; values revalidate; per-widget errors visible.

### [P2] OBS-2 — Shared `useFund()` store to kill duplicate fetches
- Complexity: M · Assignee: Claude · Deps: none · Branch: `claude/fund-shared-store` · PR: `refactor(fund): shared holdings/quotes store`
- **Scope (L3):** One holdings/watchlist/quotes fetch hydrates all Fund subroutes; batch quotes via `/api/massive/snapshot`.
- **Headline acceptance:** Navigating Fund subroutes triggers no duplicate holdings/quote fetches in a session; quotes batched.

### [P2] OBS-3 — Pagination/limits on high-volume lists
- Complexity: M · Assignee: Claude · Deps: none · Branch: `claude/list-pagination` · PR: `feat(data): cursor pagination for tasks/notes/signals/transactions`
- **Scope (L4):** Add `.limit()` + cursors to `useTasks`/`useSignals`/`useNotes` + `fund_bank_transactions`; virtualize long lists.
- **Headline acceptance:** No list query is unbounded; transactions/notes paginate with load-more; refresh restores page 1.

### [P3] OBS-4 — Lazy-load heavy client bundles
- Complexity: S · Assignee: Claude · Deps: none · Branch: `claude/lazy-heavy-modules` · PR: `perf(client): dynamic-import editor + heavy modals`
- **Scope (L5):** `next/dynamic` for TipTap editor + large detail modals (Vitality/Workout, Notes editor).
- **Headline acceptance:** Notes/Vitality route JS payload drops measurably (report before/after); no SSR/hydration regressions.

### [P2] OBS-5 — Request timing metrics on core API routes
- Complexity: S · Assignee: Claude · Deps: PROD-2 · Branch: `claude/api-timing-metrics` · PR: `feat(observability): timing spans on core routes`
- **Scope:** Add Sentry performance spans/timing logs to mail/calendar/fund/ai routes + provider calls; tag provider/op.
- **Headline acceptance:** Core routes emit timing spans visible in Sentry; provider call latency captured; no PII; sampling sane.

---

## PROJECT 7 — UX / Design System
*Audit refs: U3, U4, U5, U6, A1 (extraction enables consistency). Use existing AppShell/Card/Modal/Toast tokens.*

### [P2] UX-1 — Standardize loading/empty/error/disconnected states
- Complexity: M · Assignee: Claude · Deps: none · Branch: `claude/ux-standard-states` · PR: `feat(ux): shared state components`
- **Scope:** Extract shared `EmptyState`/`ErrorState`/`LoadingState`/`DisconnectedState` from the patterns already in hooks; apply to modules with weak states (Vault, Supper Club, Library, Debrief).
- **Headline acceptance:** Targeted modules use the shared states; every list/detail has explicit loading/empty/error; visually consistent with tokens.

### [P2] UX-2 — Debrief reminder: real persistence + delivery (or remove)
- Complexity: M · Assignee: Review-needed · Deps: DATA-1, cron · Branch: `claude/debrief-reminder` · PR: `feat(debrief): persistent reminder with delivery`
- **Scope (U4):** Move the localStorage reminder to Supabase (owner RLS) + deliver via cron + Make/notification; or remove the affordance if delivery isn't in scope.
- **Headline acceptance:** Reminder persists cross-device; a scheduled job actually fires it (or the feature is removed, not faked); no localStorage-only state.

### [P3] UX-3 — Supper Club: back with a table or mark demo-only
- Complexity: S · Assignee: Review-needed · Deps: DATA-1 · Branch: `claude/supper-club-decision` · PR: `feat(supper-club): persist saves` / `chore: mark demo-only`
- **Scope (U3):** Either add a `recipes`/`recipe_saves` table (owner RLS) so saves persist, or clearly label the module demo-only in the UI.
- **Headline acceptance:** Saves persist cross-device with RLS, OR the module is unambiguously marked demo-only; no silent localStorage-as-truth.

### [P3] UX-4 — Real detail views for Objectives/Pipeline/Agenda/Atelier
- Complexity: M · Assignee: Claude · Deps: none · Branch: `claude/detail-views` · PR: `feat(ux): focused detail views`
- **Scope (U6):** List items open into a focused detail view (history, related items, actions), per the Definition of Done.
- **Headline acceptance:** Clicking an item in each module opens a usable detail view with actions; not just inline edit.

### [P2] UX-5 — Decompose one god module as the extraction template (Vitality)
- Complexity: L · Assignee: Review-needed · Deps: none · Branch: `claude/vitality-decompose` · PR: `refactor(vitality): split into tab subcomponents`
- **Scope (A1):** Split `VitalityModule` (1,935 LOC) into `{TrainingTab,NutritionTab,MeditationTab,DevicesTab}` + keep logic in hooks; establishes the pattern for Notes/ControlRoom/Console/Vault.
- **Headline acceptance:** No Vitality file >500 LOC; behavior identical (smoke-tested); pattern documented for the other god modules.

---

## PROJECT 9 — AI Workflow Layer
*Audit refs: I2 (orphaned crons), AI router strengths to preserve. `lib/ai/router.ts` is good — harden around it.*

### [P1] AI-1 — Wire the orphaned crons (feed-digest, intelligence-sweep)
- Complexity: S · Assignee: Review-needed · Deps: PROD-3 · Branch: `claude/wire-orphaned-crons` · PR: `fix(cron): schedule feed-digest + intelligence-sweep`
- **Scope (I2):** Add both to `vercel.json` crons (verify plan cron limits) or the GH Actions schedule with `CRON_SECRET`; document the full cron map; confirm each runs once.
- **Headline acceptance:** All 4 cron routes have a working trigger; a manual + scheduled run is logged for feed-digest + intelligence-sweep; auth via `CRON_SECRET` enforced.

### [P2] AI-2 — AI router resilience + observability
- Complexity: S · Assignee: Claude · Deps: INT-6, PROD-2 · Branch: `claude/ai-router-observability` · PR: `feat(ai): capture router fallbacks + failures`
- **Scope:** Capture Gemini→Haiku fallbacks + total failures to Sentry (tagged mode/provider); ensure `/api/ai/status` reflects real key availability; rate-limit verified.
- **Headline acceptance:** Fallbacks/failures visible in Sentry with mode tags; `/api/ai/status` accurate; no key values logged; happy path silent.

### [P2] AI-3 — Surface AI insights honestly (finance/objectives/literature)
- Complexity: M · Assignee: Claude · Deps: AI-2 · Branch: `claude/ai-insights-surfaces` · PR: `feat(ai): consistent insight states`
- **Scope:** Ensure `ai_insights` consumers show generated/loading/failed/heuristic-fallback states clearly (no fake confidence); persist + dedupe insights.
- **Headline acceptance:** Each AI insight surface shows whether it's model-generated vs heuristic fallback vs failed; insights persist; no silent empty.

### [P2] AI-4 — Semantic search reliability (pgvector)
- Complexity: M · Assignee: Review-needed · Deps: DATA-1 · Branch: `claude/semantic-search-reliability` · PR: `feat(search): robust semantic search`
- **Scope:** Verify `/api/search/semantic` + `note_embeddings` + `similarity_search` RPC (migrations 023/024/029) are applied + RLS-safe; handle embedding-provider failure gracefully; confirm embeddings stay Gemini-only.
- **Headline acceptance:** Semantic search returns owner-scoped results; embedding failures degrade to keyword search with a visible note; RPC confirmed applied + RLS-safe.

---

## PROJECT 10 — Integration Health + Control Room
*Primary issues live in Project 3 (INT-3/4/5/7). Remaining Control-Room-specific work below. Audit refs: A1, I1.*

### [P1] IHC-1 — Health-device integration decision (build vs gate)
- Complexity: S (decision) / L (if build) · Assignee: Human (decision) → Review-needed (build) · Deps: DATA-2 · Branch: `claude/health-device-decision` · PR: `docs(integrations): health-device decision`
- **Scope (I1):** Decide whether to build the Oura/Whoop/Fitbit/Garmin OAuth loop (callbacks + `health_connections` table + sync + env keys) or formally gate it as "Planned" (PROD-7 handles the UI). Record the decision; if "build," scope the follow-up.
- **Headline acceptance:** A recorded decision; if "gate," the dead connect routes are removed/guarded and the UI is honest (PROD-7); if "build," a scoped multi-issue plan exists (callbacks, table+RLS, sync, env).

### [P2] IHC-2 — Decompose Control Room into per-integration components
- Complexity: L · Assignee: Review-needed · Deps: INT-1, INT-4 · Branch: `claude/control-room-decompose` · PR: `refactor(control-room): extract integration components`
- **Scope (A1):** Split the 1,317-LOC, 19-fetch `ControlRoomModule` into `IntegrationSection`/`IntegrationRow` + hooks reading the registry; no behavior change.
- **Headline acceptance:** No Control Room file >500 LOC; zero raw `fetch` in the module (moved to hooks/services); all flows identical (smoke-tested).

### [P2] IHC-3 — Audit-log surface for integration + auth events
- Complexity: S · Assignee: Claude · Deps: `audit_logs` (migration 038) · Branch: `claude/control-room-audit-log` · PR: `feat(control-room): show recent security/integration events`
- **Scope:** Render recent `audit_logs` (connects, disconnects, auth changes) in Control Room so the user can see account activity; owner RLS.
- **Headline acceptance:** Control Room shows the user's recent audit events (time, action, provider); owner-scoped; empty/loading/error states; no PII leakage.

---
---

## Appendix A — Issue index

| ID | Title | P | Project | Complexity | Status |
|---|---|---|---|---|---|
| MAIL-1 | Composio Gmail messages open into detail | P0 | Mail | M | Todo |
| MAIL-2 | Composio Outlook messages open into detail | P0 | Mail | S | Todo |
| MAIL-3 | Visible error + retry on detail failure | P0 | Mail | S | Todo |
| MAIL-4 | Mail adapter contract | P0 | Mail/Int | M | Todo |
| MAIL-5 | Reply/send parity | P1 | Mail | M | Backlog |
| MAIL-6 | Archive/delete/mark-read | P1 | Mail | M | Backlog |
| MAIL-7 | Pagination + load-more | P1 | Mail | M | Backlog |
| MAIL-8 | Cache-first inbox | P1 | Mail/Data/Latency | L | Backlog |
| MAIL-9 | Sentry instrumentation | P1 | Mail/Obs | S | Backlog |
| MAIL-10 | Preview QA checklist | P1 | Mail/Prod | XS | Backlog |
| INT-1 | Adapter registry | P0 | Int | M | Backlog |
| INT-2 | Normalize provider accounts | P0 | Int/Data | M | Backlog |
| INT-3 | Provider health model | P1 | Int/IHC | M | Backlog |
| INT-4 | Status in Control Room | P1 | IHC | M | Backlog |
| INT-5 | Reconnect flow | P1 | IHC | M | Backlog |
| INT-6 | Structured provider errors | P0 | Int/Obs | S | Backlog |
| INT-7 | Sync-state model | P1 | Int/Data | M | Backlog |
| DATA-1 | Migration audit/reconcile | P0 | Data | M | Todo |
| DATA-2 | Missing-tables catalog | P0 | Data | S | Todo |
| DATA-3 | Mail cache table | P1 | Data/Mail | M | Backlog |
| DATA-4 | Sync-state table | P1 | Data | S | Backlog |
| DATA-5 | Provider id-map table | P1 | Data | S | Backlog |
| DATA-6 | RLS verification | P0 | Data/Sec | S | Backlog |
| DATA-7 | Tembo role investigation | P0 | Data/Infra | S | Todo |
| DATA-8 | Tembo decision | P1 | Data/Infra | S/M | Backlog |
| PROD-1 | Env var validation | P1 | Prod | S | Todo |
| PROD-2 | Sentry verification | P1 | Prod/Obs | S | Todo |
| PROD-3 | Vercel deploy checklist | P1 | Prod | XS | Backlog |
| PROD-4 | GitHub PR workflow | P2 | Prod | XS | Backlog |
| PROD-5 | Playwright mail smoke | P1 | Prod/Test | M | Backlog |
| PROD-6 | API structured errors | P1 | Prod/Obs | M | Backlog |
| PROD-7 | Missing-provider degradation | P1 | Prod/IHC | M | Backlog |
| CAL-1…5 | Calendar + Agenda slice | P1/P2 | Calendar | S–L | Backlog |
| DISP-1…4 | Dispatch + Command | P1–P3 | Dispatch | XS–M | Backlog |
| OBS-1…5 | Latency + Observability | P1–P3 | Latency | S–L | Backlog |
| UX-1…5 | UX / Design System | P2/P3 | UX | S–L | Backlog |
| AI-1…4 | AI Workflow Layer | P1/P2 | AI | S–M | Backlog |
| IHC-1…3 | Integration Health + Control Room | P1/P2 | IHC | S–L | Backlog |

## Appendix B — Critical path to MVP
`DATA-1` + `DATA-7` (unblock schema + resolve Tembo) → `MAIL-1 → 2 → 3` (kill the known bug, milestone M0) → `INT-1 → INT-6 → INT-2` (adapter spine) → `MAIL-4` (contract) → `DATA-3/4/5 → DATA-6` (cache/sync schema + RLS) → `MAIL-8` (cache-first) → `INT-3 → INT-4 → INT-5 → INT-7` (health + reconnect + sync visibility) → `PROD-1 → PROD-2 → PROD-5 → PROD-7` (production-ready). Everything else (CAL/DISP/OBS/UX/AI/IHC) layers on after M0–M4.

*End of plan. Generated from `docs/audits/axis-platform-audit.md`. No application code changed.*
