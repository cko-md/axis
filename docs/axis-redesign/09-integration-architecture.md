# 09 — Integration architecture

Integrations are untrusted, failure-prone boundaries. Provider payloads are
normalized before they enter domain code, provider accounts are owner-resolved
before every operation, and writes never inherit authority from external
content. The shared contract is defined in
[`src/lib/integrations`](../../src/lib/integrations).

## Layering

```text
authenticated route / service
  → owner account or resource lookup
  → capability + action-policy check
  → provider/transport adapter
  → schema normalization + provenance
  → Result<domain value> or normalized IntegrationError
  → cache/domain persistence and visible UI feedback
```

Provider-specific models, status strings, pagination, and error bodies stop at
the adapter boundary. Domain services and components consume normalized types.
Routes may translate normalized error codes to HTTP status, but must not branch
on provider-specific payload fields.

## Shared result and error contract

[`types.ts`](../../src/lib/integrations/types.ts) defines:

```ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: IntegrationError };
```

Errors use the normalized codes `auth_expired`, `rate_limited`, `not_found`,
`not_supported`, `invalid_request`, `provider_error`, `network`, and `unknown`,
with safe message, retryability, provider, transport, and status metadata.
Adapters return expected provider/auth/network failures; they do not throw them
through route boundaries.

Retries are operation-aware:

- bounded retries are acceptable for idempotent reads on retryable failures;
- writes are attempted once unless the provider supports a verified idempotency
  key and Axis has a durable claim/outbox;
- `401/403`, invalid input, not found, and unsupported capability are not blind
  retry candidates;
- response bodies, tokens, email content, webhook paths, and raw OAuth payloads
  never enter errors or Sentry.

## Adapter selection, ownership, and capabilities

The registry in [`registry.ts`](../../src/lib/integrations/registry.ts) is the
dependency-light source for advertised provider/transport capabilities. It does
not hold credentials or adapter instances.

An operation follows this order:

1. authenticate the Axis user;
2. load the connected account/resource through an owner-filtered query;
3. reject an unknown or foreign account before adapter resolution;
4. resolve the adapter from the stored provider and transport marker;
5. verify the capability is enabled;
6. classify the action through [`actionPolicy.ts`](../../src/lib/security/actionPolicy.ts);
7. execute and normalize the result;
8. persist only the allowed normalized data and emit safe timing/error metadata.

A client-supplied provider, email address, account id, connected-account id, or
approval id is a lookup hint, never proof of ownership.

## Normalization and provenance

Adapters validate provider responses and return domain records with stable ids,
currency, retrieval/as-of timestamps, provider, and transport where relevant.
Unknown/malformed provider fields are rejected or omitted; they are not asserted
into trusted types.

Financial provider rows remain partitioned until owner, currency, freshness,
and permission are compatible. Mail normalizes headers, snippets, flags, and
dates for cache/list use; bodies and attachments remain live detail operations.
The canonical entity/search layer consumes local owner projections and never
adds live provider fan-out to the render-critical path.

## Cache-first reads

The default slow-provider read model is stale-while-revalidate:

1. read owner-scoped normalized cache rows;
2. render the last-known value with explicit freshness/error state;
3. explicitly trigger provider revalidation;
4. merge successful accounts/sources;
5. retain healthy cached data when one source fails;
6. update cache and sync state only with normalized data.

Mail implements this flow in [`mail/cache.ts`](../../src/lib/mail/cache.ts) and
[`/api/mail/sync`](../../src/app/api/mail/sync/route.ts); see
[`mail-cache-sync.md`](../architecture/mail-cache-sync.md). The cache excludes
bodies, attachments, tokens, raw payloads, and provider error bodies. Widgets
follow the same principle through [`widget-cache.md`](../architecture/widget-cache.md).

A serverless response must not start an untracked background refresh. Work that
must survive the request belongs in a durable job/run/outbox.

## Writes, outbox, and idempotency

External communication and financial execution require stronger boundaries than
reads.

- Make notifications persist an encrypted payload before delivery, use a
  hashed dedupe key, claim replay with compare-and-set, cap attempts, and expose
  safe owner metadata only. See
  [`makeOutbox.ts`](../../src/lib/integrations/makeOutbox.ts) and
  [`make-notifications.md`](../architecture/make-notifications.md).
- A provider `2xx` means accepted, not delivered or reconciled. Final state must
  distinguish provider acknowledgement from downstream completion.
- The Public brokerage adapter prepares and verifies deterministic
  `FINANCIAL_EXECUTION` drafts, but live submission is disabled in
  [`publicOrderAdapter.ts`](../../src/lib/brokerage/publicOrderAdapter.ts).
- Rebalance is simulation-only. A future broker submitter needs a durable
  provider idempotency key, exact approval consumption, fresh step-up,
  acknowledgement persistence, reconciliation, and operator-visible recovery.
- External content is never an instruction source. Email/web/provider text may
  become evidence, but cannot raise permissions or approve a write.

The Make outbox is not a blanket claim that every provider write is durable.
Any new write path must either prove provider idempotency or introduce its own
reviewed outbox/claim protocol before enabling retries.

## Current provider matrix

| Domain/provider | Implemented boundary | Automated evidence | Live/external evidence still required |
|---|---|---|---|
| Gmail direct | Full Mail adapter contract: list/detail/send/reply/read-state/archive/trash/attachments | Adapter normalization, parity, send/reply, action, route, and cache tests | Active direct Gmail account across the full workflow on preview. |
| Outlook direct | Full Mail adapter contract | Adapter normalization/parity and shared route/cache tests | Active direct Outlook list/detail/send/reply/actions/attachments on preview. |
| Gmail via Composio | List/detail/send/reply and verified mutations; attachment download remains disabled | Adapter/parity/action/cache tests | Current release has live list/detail evidence; repeat send/reply/mutations with an active account and inspect Sentry. |
| Outlook via Composio | List/detail/send/reply; mutations and attachment download remain `not_supported` | Contract/parity/error tests | Active account validation is required before enabling any disabled mutation. |
| Plaid | Normalized accounts, transactions, and liabilities through [`plaid/adapter.ts`](../../src/lib/plaid/adapter.ts) | Pure normalizer and adapter tests | Configured sandbox/production connection, webhook, stale/auth-expired, and reconciliation checks. |
| Polygon/Massive market data | Bounded read adapter and quote provenance | Unit/route tests for shape, retry, partial, stale, and failure behavior | Configured quote coverage on preview; all-symbol completeness for rebalance simulation. |
| Public brokerage | Deterministic prepare/verify boundary; submit disabled | Order-ticket and adapter tests | A separately authorized sandbox submit/reconcile implementation; no production execution exists. |
| Make | Validated management reads and encrypted notification outbox; writes are one-attempt/explicit replay | Result, schema, encryption, tamper, dedupe, replay, and dead-letter tests | Live write acceptance and Make-side idempotency/delivery verification. |
| Calendar and Contacts | Existing provider routes/services | Existing feature tests only | Shared adapter/registry migration and direct/Composio parity remain deferred. |
| Health/device providers | Existing module-specific paths | Existing feature tests only | Product/provider decision and privacy review remain external. |

## Observability contract

Each provider operation records only safe dimensions: request/correlation id,
domain, provider, transport, normalized operation, outcome/error code, status,
retryability, cache outcome, freshness tier, and duration. The redaction and
capture helpers live under [`src/lib/observability`](../../src/lib/observability);
dashboard queries and alert thresholds are specified in
[`14-observability-dashboards.md`](14-observability-dashboards.md).

Expected user errors such as not found or disconnected accounts are visible but
not escalated as unexpected exceptions. Provider `5xx`, schema violations,
network failures, cache corruption, and impossible state transitions are
captured with safe metadata.

## Adapter acceptance contract

A provider capability is production-enabled only when all of these are true:

- normalized success and every error code are contract-tested;
- owner and foreign-account paths are tested;
- capability registry and UI affordances agree;
- pagination, empty, partial, stale, disconnected, rate-limited, and recovery
  states are visible;
- read retries and write idempotency semantics are explicit;
- cache/outbox privacy and RLS/grants are verified where persistence changes;
- a live provider account exercises the enabled operation on the Vercel preview;
- the post-preview Sentry query shows no new regression or private-data leak.
