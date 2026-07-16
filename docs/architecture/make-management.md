# Make management API boundary

## Scope

`src/lib/integrations/make.ts` owns the server-only Make API v2 management
boundary for scenario discovery, detail, execution, activation, and
deactivation. It is separate from opaque custom-webhook delivery and from the
encrypted notification outbox.

The request/response shapes follow Make's current
[scenario API reference](https://developers.make.com/api-documentation/api-reference/scenarios).
Scenario runs send `{ responsive: true, data: ... }`; `input` is not a valid
field for this endpoint.

## Contract

Every exported management operation returns the shared `Result<T>` contract:

- `listScenarios()` returns validated scenario summaries;
- `getScenario(id)` returns one validated scenario;
- `runScenario(id, data)` returns a validated execution id/status receipt;
- `setScenarioActive(id, active)` returns the confirmed id and active state.

No operation throws a provider error to its caller. Errors contain only a
normalized code, safe message, retryability, provider, and HTTP status. Make
response bodies, API tokens, scenario inputs, and thrown fetch messages never
enter Results, logs, or Sentry exceptions.

## Retry and write safety

Read-only requests use at most three attempts with bounded backoff for transient
network/status failures. Scenario run/start/stop writes perform exactly one
attempt. A caller may offer an explicit retry after reviewing the structured
failure, but no adapter-level write retry is allowed.

Redirects are rejected so the token cannot follow a provider redirect. API
zone, team id, and scenario id are validated before fetch. Successful response
bodies are validated with Zod before they reach a caller. Activation and
deactivation also require Make's returned id/state to match the request.

## Action policy

Scenario run/start/stop are external side effects. This low-level adapter does
not grant authority: a future route or routine caller must authenticate the
owner, classify the scenario's actual action, satisfy the corresponding Axis
approval policy, and preserve the no-autonomous-financial-execution rule before
calling a write operation. Provider output remains untrusted data and never
authorizes a later action.

## Verification

Unit tests cover missing/invalid configuration, invalid ids, bounded read
retry, one-shot writes, malformed responses, non-serializable inputs, the
documented `data` request field, activation confirmation, and secret-free
failure handling. Live verification is read-only: list scenarios and load one
detail, reporting only counts and shape checks rather than scenario names or
provider payloads.
