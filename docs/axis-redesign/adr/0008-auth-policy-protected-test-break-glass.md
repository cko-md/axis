# ADR 0008 — One-use protected-test correction for the AUTH-007 default-deny boundary

- Status: pending independent review and exact candidate dry-run
- Date: 2026-07-30
- Scope: AUTH-007 only
- Base protected-test blob: `97c7e592bcec41acd80e5537da1af8de46f789c5`
- Candidate protected-test blob: `9fa52aab7a27f42744dedfae74f68b756d6365f2`
- Base protected-test SHA-256: `798dbe42c819b7c9d14cddd03650ce7bd31dac2389fd77685bc263a1c2fbdded`
- Candidate protected-test SHA-256: `f93f723194c23387739d34591bce447d1a0725bde67a0d1b28266f5bcd598548`

## Context

`src/middleware.test.ts` was a protected, byte-frozen test during the AUTH-007
recovery. Its final assertion expected the unclaimed path
`/api/auth/profile-evil` to reach the route layer. That expectation encodes the
previous prefix-based middleware policy, where a near collision with
`/api/auth/profile` was accidentally left open.

AUTH-007 changes the contract to explicit exact exceptions and authenticated
default deny for every other API path. Under that contract the same path must
return the standard `401 UNAUTHORIZED` response before a route is reached.

## Decision

The proposed one-use break-glass scope is exactly one protected-test edit:
replace the stale `200`/middleware
pass-through expectation for `/api/auth/profile-evil` with the existing
standard `401 UNAUTHORIZED` response assertion, and rename only that test to
describe default-deny behavior. No tombstone route, middleware exception,
environment switch, or test-only bypass is permitted.

## Threat analysis

Leaving the old assertion intact pressures the implementation toward a
near-collision exception or an unowned `404` tombstone. Either design weakens
the default-deny rule, creates a future route-claim risk, and makes unreviewed
API names part of the anonymous surface. Correcting the assertion preserves
the security boundary: new and lookalike `/api/*` paths are denied unless they
are named in the small audited policy inventory.

## One-use external executor requirements

This decision is not merge authorization. Before the protected test replacement
is accepted for merge, an external executor must verify the exact base and candidate
blob hashes above, confirm the candidate diff changes only this test title and
the `/api/auth/profile-evil` assertion, and dry-run the focused AUTH-007 test
set. A second reviewer must independently confirm the middleware policy has no
tombstone, prefix exception, route rewrite, or environment-dependent bypass
for that path. The executor must record the dry-run result with the candidate
hash before any merge request is authorized. The resulting evidence artifact
expires within 24 hours and is valid for one acceptance attempt only. After
use, destroy or cryptographically invalidate the one-use executable/envelope,
retain the sanitized immutable receipt as audit evidence, and destroy any
secret-bearing journal after verified cleanup. Any source SHA change invalidates
the receipt and requires a fresh external execution and independent review.

## Rollback and invalidation

Rollback restores the exact base blob only if the whole AUTH-007 middleware
candidate is abandoned; it must not restore anonymous access through a runtime
exception. This ADR expires once the identified candidate is merged or
superseded. Any change to the protected-test diff, middleware exception list,
Sentry tunnel source, or candidate blob hash invalidates this decision and
requires a new review.
