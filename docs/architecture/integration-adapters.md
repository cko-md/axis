# Integration Adapter Architecture

> Status: implemented for **Mail** (Gmail/Outlook × direct-OAuth/Composio). Designed to extend to Calendar and Contacts next.
> Goal: stop scattering "direct OAuth vs Composio" branching through API routes and UI components. Routes select an adapter and call generic methods; the UI only ever sees normalized types.

---

## Why

Before this change, provider/transport branching lived in route handlers:

- `GET /api/mail/message/[id]` only called the direct-OAuth readers — it had **no Composio branch**, so Composio-connected messages returned 404 and never opened (the known "Composio inbox lists but won't open detail" bug).
- `GET /api/mail/inbox` and `POST /api/mail/send` each re-implemented a `via === "composio" ? … : provider === "gmail" ? … : …` ladder.
- Errors were stringly-typed (`{ error: "Gmail error: …" }`), so callers couldn't distinguish "token expired → reconnect" from "rate limited → retry".

Every new capability multiplied the branching. The adapter layer collapses it into one contract.

---

## Layers

```
src/lib/integrations/
  types.ts        ← transport-agnostic primitives: Result<T>, IntegrationError,
                    error codes, status/exception mappers (reused by all domains)
  registry.ts     ← which providers exist, over which transports, with what
                    capabilities (dependency-light; safe to import in UI)

src/lib/mail/adapters/
  types.ts            ← MailAdapter contract + normalized mail types + MailAccountContext
  gmail-direct.ts     ← direct-OAuth Gmail
  outlook-direct.ts   ← direct-OAuth Outlook
  gmail-composio.ts   ← Composio Gmail
  outlook-composio.ts ← Composio Outlook
  index.ts            ← resolveMailAdapter() / adapterForAccount() / mailErrorStatus()
```

Existing modules are **reused, not removed** (legacy direct OAuth stays):

- `src/lib/mail/gmail.ts` / `outlook.ts` — direct list/get + body normalization (now also `export` their header/body helpers).
- `src/lib/mail/composio.ts` — Composio list/send + normalizers, now also exports `getComposioMessage` (new) and the message normalizers.
- `src/lib/mail/tokens.ts` — `listMailAccounts()` returns the unified `MailAccountRef[]` (with `via` + `connectedAccountId`) that drives adapter selection.

---

## The mail contract

`MailAdapter` (see `src/lib/mail/adapters/types.ts`):

| Method | Returns | Notes |
|---|---|---|
| `listInbox(ctx, opts?)` | `Result<InboxPage>` | `opts.pageToken` (Gmail) / `opts.skip` (Outlook) |
| `getMessage(ctx, id)` | `Result<MailMessageFull>` | fixes the Composio detail bug |
| `sendMessage(ctx, input)` | `Result<SendResult>` | new message |
| `replyToMessage(ctx, input)` | `Result<SendResult>` | `inReplyTo`/`references`/`threadId` |
| `markRead(ctx, id)` | `Result<void>` | |
| `markUnread(ctx, id)` | `Result<void>` | |
| `archiveMessage(ctx, id)` | `Result<void>` | |
| `deleteMessage(ctx, id)` | `Result<void>` | |
| `getAttachment(ctx, id, attachmentId)` | `Result<MailAttachmentFile>` | direct providers download bytes for Library; Composio returns structured `not_supported` until safe attachment tools are verified |
| `normalizeMessage(raw, ctx)` | `MailMessage \| null` | pure; raw provider → shared shape |
| `normalizeMessageFull(raw, ctx)` | `MailMessageFull \| null` | pure; adds body |

All four adapters return the **same** `MailMessage` / `MailMessageFull` types and the **same** `Result<T>` error envelope.

### `MailAccountContext`

Built from a `MailAccountRef` + the authenticated user id via `toMailContext(userId, account)`. Adapters are **stateless singletons**; per-call account/transport context is passed in, so ownership is verified by the route (which calls `listMailAccounts` first), not the adapter.

---

## Error model

Every method returns `Result<T> = { ok: true; data } | { ok: false; error: IntegrationError }`. `IntegrationError.code` is one of:

| code | meaning | route HTTP (`mailErrorStatus`) | retryable |
|---|---|---|---|
| `auth_expired` | token missing/expired/revoked → reconnect | 401 | no |
| `invalid_request` | malformed call/input | 400 | no |
| `not_found` | object doesn't exist | 404 | no |
| `rate_limited` | provider throttled | 429 | yes |
| `not_supported` | provider/transport can't do this op | 501 | no |
| `provider_error` | provider returned an unclassified error | 502 | yes |
| `network` | fetch/timeout/abort | 502 | yes |
| `unknown` | anything else | 502 | yes |

Mappers in `integrations/types.ts`: `codeFromStatus(status)`, `failFromStatus(...)`, `failFromException(...)` (recognizes `ComposioError`'s numeric `status`). Routes translate `code → HTTP` via `mailErrorStatus()` and capture `5xx`-class failures to Sentry (tags: `area:mail`, `op`, `provider`, `transport`, `code`) — never logging tokens or message bodies.

---

## How routes use it

```ts
const accounts = await listMailAccounts(user.id);
const account = accounts.find((a) => a.provider === provider && a.mailEmail === email);
if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

const adapter = adapterForAccount(account);            // picks gmail/outlook × direct/composio
const result  = await adapter.getMessage(toMailContext(user.id, account), id);

if (result.ok) return NextResponse.json(result.data);  // success shape unchanged
return NextResponse.json({ error: result.error.message, code: result.error.code },
                         { status: mailErrorStatus(result.error.code) });
```

Rewired routes: `api/mail/inbox`, `api/mail/message/[id]`, `api/mail/send`. None of them name a provider transport anymore. `api/mail/send` accepts an optional transport hint (`direct` or `composio`) so the composer can target the exact connected account, and it may return a safe `warning` string when the provider sends successfully with a documented limitation.

---

## Capability registry

`src/lib/integrations/registry.ts` declares, per `(domain, provider, transport)`, what's supported. Today:

- **Gmail/Outlook direct** — full (list/read/send/reply/markRead/archive/delete/attachmentDownload).
- **Gmail Composio** — full for list/read/send/reply/actions. `markRead`/`markUnread` use `GMAIL_ADD_LABEL_TO_EMAIL` to remove/add `UNREAD`, `archive` removes `INBOX`, and `delete` uses `GMAIL_MOVE_TO_TRASH` (recoverable trash, matching the direct Gmail adapter). Attachment download remains **unsupported** until a safe Composio attachment byte-download path is verified; the UI routes those attachments via Dispatch/Library instead of implying direct save.
- **Outlook Composio** — list/read/send/reply. `markRead`/`archive`/`delete` and attachment download remain **unsupported** until an active Composio Outlook account is available for live validation; the adapter returns a structured `not_supported` error and the UI disables or relabels the affordances.

UI/Control Room should read `getCapabilities(domain, provider, transport)` to decide which affordances to show.

### Composio verification caveats

Composio tool-slug accuracy is confirmed only for the already-live paths (list via `GMAIL_FETCH_EMAILS` / `OUTLOOK_OUTLOOK_LIST_MESSAGES`, send via `GMAIL_SEND_EMAIL` / `OUTLOOK_OUTLOOK_SEND_EMAIL`). New in this change:

- **`getMessage`** uses single-message slugs (`GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, `OUTLOOK_OUTLOOK_GET_MESSAGE`) with defensive payload parsing. Gmail detail has been verified against a live Composio account; Outlook detail still needs an active Outlook account for final live validation.
- **Composio `replyToMessage`** intentionally degrades to the verified send tools until native threading args are confirmed. The composer displays this before send, and the API returns a safe success warning after send so the limitation is explicit rather than hidden.
- **Gmail Composio actions** are verified and wired. **Outlook Composio actions** stay `not_supported` until active-account validation confirms the right mutation semantics and folder IDs.

---

## Extending to Calendar / Contacts

Repeat the mail pattern: add `src/lib/calendar/adapters/{types,*-direct,*-composio,index}.ts` implementing a `CalendarAdapter` that returns `Result<T>` with the shared `IntegrationError`, register providers in `registry.ts`, and slim the calendar routes to `resolveCalendarAdapter(...)`. Reuse `integrations/types.ts` verbatim.

---

## Manual test checklist

Run against local dev and again on the Vercel preview.

1. **Start dev server:** `npm run dev`; open `http://localhost:3000`.
2. **Log in.**
3. **Connect providers** (Control Room → Integrations, or Mail → + Add): connect at least one **Composio Gmail** account; if available, also **Composio Outlook**, **direct Gmail**, and **direct Outlook**.
4. **Navigate to `/mail`.**
5. **Inbox (list) — happy path:** the inbox lists messages from every connected account, newest first. Account filter chips scope correctly.
6. **Open detail — the bug fix:**
   - Click a **Composio Gmail** row → `MessagePanel` opens with subject, sender, date, and rendered body. *(This previously failed.)*
   - Click a **Composio Outlook** row → opens with full detail.
   - Click a **direct Gmail** and **direct Outlook** row → still open correctly.
   - Body HTML renders sanitized; plain-text renders readably.
7. **Send — happy path:** Compose → send a test message from a Composio account and (if connected) a direct account → success toast; message arrives in the real mailbox.
8. **Reply:** open a message → Reply → send → arrives; subject is `Re: …` (not doubled).
9. **Attachments:** for direct Gmail/Outlook, route an attachment to Library and confirm the file is saved. For Composio Gmail/Outlook, confirm the attachment affordance is labeled as Dispatch routing, not direct download.
10. **Error path (no silent failures):**
   - Temporarily break a Composio slug (e.g. edit `GET_TOOL` to an invalid value) → opening a Composio message returns a visible error (HTTP 502), not an infinite spinner; restore the slug.
   - Disconnect an account mid-session and refresh → that account's rows disappear; remaining accounts still list (one account failing never blanks the inbox).
11. **Persistence:** refresh `/mail` → accounts + inbox reload; re-opening a message still works.
12. **Vercel preview:** repeat steps 4–11 on the preview deploy URL.
13. **Sentry:** confirm the happy paths create **no** new Sentry error; confirm the forced error in step 10 produces a Sentry event tagged `area:mail`, `op`, `provider`, `transport`, `code` with no token/body PII.
14. **Regression — related modules:** Control Room integrations still connect/disconnect; Dispatch/Agenda unaffected.
15. **Build:** `npx tsc --noEmit` passes; `npm run lint` shows no new errors.

---

## Acceptance criteria (this change)

- [x] Mail API routes (`inbox`, `message/[id]`, `send`) use adapters instead of hardcoded provider branches.
- [x] Direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook share one normalized `MailAdapter` contract + types.
- [x] Every adapter method returns a structured `Result<IntegrationError>`.
- [x] Existing direct Gmail/Outlook functionality preserved (list/get delegate to existing lib functions; send/mutations moved into adapters).
- [x] Existing Composio inbox listing preserved; Composio message detail now works.
- [x] Legacy direct OAuth not removed.
- [x] `npx tsc --noEmit` passes; lint clean.
- [x] Manual test checklist documented (above).
