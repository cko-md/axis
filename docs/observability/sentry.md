# Sentry telemetry boundary

AXIS uses closed-world event builders in `src/lib/observability/sentryScrub.ts`.
They do not recursively redact arbitrary Sentry payloads. Each hook reads only
own data descriptors for a small fixed schema and emits fresh null-prototype
records and null-prototype arrays. This prevents getters, prototype pollution,
custom `toJSON`, raw targets, and arbitrary SDK fields from entering a Sentry
envelope.

AXIS is Sentry error-event-only. Transactions are unconditionally dropped;
tracing, logs, metrics, Replay, client reports, and browser/process sessions are
disabled and their integrations are filtered before initialization. Event and
breadcrumb hooks check captured `Object.prototype` and `Array.prototype`
serialization hooks both before and after strict construction.

Each client registers one terminal `beforeEnvelope` finalizer immediately after
`Sentry.init`. It accepts exactly one `event` item and verifies the lowercase
event ID and mandatory strict timestamp. The configured public DSN is parsed
and pinned for every runtime. Browser tunnel envelopes must carry that exact
canonical DSN; server and Edge direct-transport envelopes must omit the DSN
header. It then re-scrubs the payload and synchronously serializes it with the
pristine module-load `JSON.stringify`.
The final envelope contains only null-prototype headers and that pre-serialized
event string. Unsupported, malformed, or prototype-dirty envelopes are emptied,
which intentionally loses telemetry rather than risking private-data egress.
This depends on the pinned Sentry 10.59.0 contract that `beforeEnvelope` runs
before transport handling and `serializeEnvelope` appends string payloads
verbatim; hostile tests pin both behaviors, including serialization after
queued prototype pollution.

The boundary intentionally drops raw exception stacks and messages, user and
request content, headers, body/query data, arbitrary tags, and unregistered
identifiers. Exceptions become a reviewed error code or an AXIS redaction
marker. The exact route manifest remains a reviewed vocabulary source, but AXIS
does not send Sentry transactions.

Actionable diagnostics are limited to exact reviewed values in
`telemetryVocabulary.ts`: area, provider, transport, operation, code, outcome,
bounded timing/retry/size data, canonical HTTP status, and select booleans.
`http.route` is never accepted in ordinary metadata, breadcrumbs, or
`safe_fetch` contexts. The route manifest and telemetry vocabulary have drift
tests, so a source-controlled producer addition requires an explicit review and
manifest update.
The ordinary `tags.route` field likewise retains only an exact manifest route;
legacy source labels such as `ai.router` or `entities.preview` are intentionally
dropped while their reviewed area/operation/provider/code diagnostics survive.

`telemetryInventory.baseline.ts` is a second, deliberately human-readable
contract: it pins every nonliteral value and object shape reachable from a
direct AXIS telemetry-producer argument. It records each occurrence (including
duplicates), variables/constants, ternaries, property reads, shorthand fields,
spreads, computed keys, and templates. The AST test walks only producer
arguments and values reached through lexically resolved local constants; it
parses each production file once and fails for any added, removed, or changed
dynamic expression.
Literal and statically finite values discovered through that walk must be in
the vocabulary. This provenance check cannot prove every runtime value passed
through a wrapper or a property read: the runtime boundary remains fail-closed
and drops every unknown area/provider/transport/operation/code rather than
emitting it. Review a baseline change alongside the producer's safe-data test;
never regenerate it mechanically.

To register new telemetry, first add a safe coarse literal to the vocabulary,
then add or update a producer test proving it contains no message, target,
private identifier, or raw provider payload. Add route templates only to the
route manifest after confirming they are static framework routes. Do not add
regex/slug fallbacks or generic object traversal.

## Runtime configuration

- The Sentry project is `kevin-ogonuwe/javascript-nextjs` in the US region.
- Local development is quiet unless `NEXT_PUBLIC_SENTRY_DSN` is explicitly set.
- Preview and production use `NEXT_PUBLIC_SENTRY_DSN` when configured in Vercel.
- Source maps upload during Vercel builds when `SENTRY_AUTH_TOKEN` is present.
- Browser Replay is disabled (`replaysSessionSampleRate: 0` and
  `replaysOnErrorSampleRate: 0`) and no Replay integration is installed.
- Tracing, logs, metrics, client reports, and non-error envelope types are
  disabled or terminally dropped. The exported router-transition hook is a
  typed local no-op used only to satisfy the Next.js build-plugin contract.
- Browser Sentry traffic is tunneled through `/monitoring`; server and Edge
  Sentry traffic use direct transport.
- Vercel Speed Insights is separate product-performance telemetry and remains
  enabled independently; disabling Sentry tracing does not disable Speed
  Insights or its real-experience measurements.
- `scrubSentryEvent` remains a legacy compatibility sanitizer for protected
  callers and tests; it is not wired to a Sentry transport.

Do not attach OAuth payloads, access tokens, raw email bodies, or private user
content to Sentry events. Provider failures should use reviewed coarse metadata
such as `area`, `operation`, `provider`, `transport`, `code`, and HTTP status.

## Post-deploy verification

Use authenticated Sentry access after each preview and production deploy:

1. Select organization/project `kevin-ogonuwe` / `javascript-nextjs`.
2. Search unresolved issues for the exact environment and deploy window.
3. Search errors for the exact release SHA, for example
   `environment:production release:<sha>`.
4. Search route-specific errors when validating a feature, for example
   `environment:production route:"/api/mail/message/[id]/action" operation:archive`.
5. Check Vercel runtime logs for `error` and `fatal` over the same deploy window.

Happy paths should not create new Sentry issues. Expected provider 4xx failures
should return visible UI feedback and structured responses without noisy Sentry
captures.

## Historical backlog review

The 2026-06-29 KEV-10 review resolved three stale/non-production items:
the old `/briefing` hydration issue (`JAVASCRIPT-NEXTJS-2`), a localhost-only
`ENOENT stat` event (`JAVASCRIPT-NEXTJS-3`), and the Sentry sample exception
(`JAVASCRIPT-NEXTJS-1`). The reviewed release
`7685e1a01573a819664aaf5f1e0f2248c11134d3` had no production error events.
Treat this as historical evidence only; every new deploy requires an exact-SHA
review under the procedure above.
