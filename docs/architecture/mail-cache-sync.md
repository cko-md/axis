# Mail cache and synchronization

## Scope

Mail list reads are cache-first for direct Gmail, direct Outlook, Composio
Gmail, and Composio Outlook. Message detail, bodies, attachments, sends, and
provider actions remain live adapter operations.

## Read and refresh flow

1. `GET /api/mail/inbox` reads only owner-scoped Supabase cache rows and sync
   state. It makes no provider request.
2. The Mail workspace renders those rows, then calls `POST /api/mail/sync` to
   revalidate connected accounts in parallel.
3. Each adapter returns the existing normalized `Result<InboxPage>` contract.
   Successful rows are returned to the UI and written through to the cache.
4. A failed account records a normalized sync error and retains its last-known
   rows. The UI merges those stale rows with successful live account results.
5. Explicit refresh repeats step 2. Pagination also uses the sync endpoint but
   appends rows without reconciling the first-page window.

The application triggers revalidation explicitly instead of starting detached
work after a server response, which would not be durable on a serverless runtime.

## Data boundary

`mail_message_cache` stores normalized inbox-list metadata only:

- provider/transport and stable account reference
- provider message/thread ids
- sender, subject, bounded provider snippet, date, and unread state
- connected-account id for unambiguous Composio account resolution
- fetch generation and timestamps

It has no body, attachment, token, raw payload, or provider-error columns.
Message detail still fetches the body on open. `integration_sync_state` stores
only account labels, timestamps, status, generation, and normalized error codes.

Both tables have authenticated owner-only CRUD policies using `auth.uid()`, no
anonymous table grants, and indexes matching inbox and per-account generation
queries. Supabase is the persistence layer; Tembo remains unused pending an
explicit role decision.

## Reconciliation and failure behavior

A successful first-page refresh marks rows with a UUID generation, then removes
only older-generation rows inside the date window covered by that response. An
empty successful first page clears that account's cache. Pagination never prunes.
Provider or cache failures never delete last-known rows. Failed sync state keeps
the previous `last_synced_at` so freshness remains honest.

Successful mark-read/unread actions update the cached flag. Successful archive
or delete actions remove the cached row. If this secondary cache mutation fails,
the provider success is preserved, Sentry receives safe operation metadata, and
the response includes a visible warning that the next sync will reconcile it.
Disconnect removes the account's cache and sync-state rows before dropping the
local Composio connection reference. A provider `404` during a disconnect retry
means the remote account is already gone and local cleanup may continue.

## Validation

- Local migration apply and idempotent reapply.
- Local and hosted two-user owner-isolation checks.
- Hosted schema read-back: RLS enabled, four policies per table, and no forbidden
  content columns.
- Hosted security advisor: no new table finding; leaked-password protection is
  the remaining project-level setting.
- Unit and route tests cover privacy mapping, authentication, mailbox ownership,
  first-page reconciliation intent, pagination append, and normalized failure
  persistence.
