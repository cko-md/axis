# Security review — approval step-up (WebAuthn)

- Scope: wave 5.5 plus Wave 15.1 authority/session hardening.
- Review: adversarial self-review plus independent lifecycle reruns. The final
  automated rerun found no remaining P0/P1 in the reviewed scope.
- Automated ceremony evidence: Chromium CDP virtual CTAP2 platform
  authenticator, resident key, user verification enabled. Registration, real
  sign-out, passkey sign-in, fresh cookie session, authenticated API access, and
  cleanup pass end to end on `localhost`.
- Still required before real financial execution: independent human security
  sign-off and a physical-authenticator test.

## Wave 15.1 authority boundary

- Options and verification are bound to an exact opaque `ceremonyId`; the
  server loads the matching owner, purpose, approval, RP origin, and unexpired
  challenge.
- Verification consumes the matching challenge with delete-returning
  compare-and-set before authority is stamped. A replay or substituted ceremony
  loses with a visible conflict.
- Authenticator counters update through expected-counter compare-and-set; a
  concurrent stale assertion cannot overwrite the winner.
- `user_passkeys` and `webauthn_challenges` have no browser policies or grants.
  Authenticated server routes owner-scope first, then use service-role authority.
- Passkey login does not persist a Supabase refresh token and has no browser
  token-exchange route. After assertion verification, the server mints a
  one-time Supabase link, consumes it through the SSR client, verifies the
  resulting session owner, and returns only the response carrying secure
  cookies.
- Approval execution enforces a five-minute maximum age for
  `step_up_verified_at`; stale verification returns `APPROVAL_STEP_UP_STALE`.

## Threat analysis & findings

| # | Concern | Assessment | Action |
|---|---------|-----------|--------|
| 1 | **Self-attested step-up** (client claims `stepUpVerified: true`) | Was the original hole. | **Fixed** — boolean removed; `step_up_verified_at` set only after a verified assertion. |
| 2 | **IDOR** — verifying step-up on another user's approval | `loadApproval` + the update are scoped `user_id = auth.uid()`; the passkey lookup is scoped to the user + `credential_id`. | Safe. |
| 3 | **Foreign credential** — asserting with someone else's passkey | Passkey must match `user_id = auth.uid()` AND `credential_id = response.id`. | Safe. |
| 4 | **Challenge replay/substitution** | Exact ceremony, purpose, owner, RP origin, approval, and expiry are checked; delete-returning consumption admits one winner. | Safe. |
| 5 | **Confused-deputy across the user's own approvals** — a challenge minted for approval A used to verify approval B | A substituted ceremony cannot satisfy the exact approval binding. | **Hardened** — challenge carries `approval_id` and opaque ceremony identity; verify requires both. |
| 6 | **Brute force / ceremony-store abuse** | No throttle originally. | **Hardened** — registration and approval option/verification issuance is per-user throttled; pre-auth login options/verification is per-IP throttled, with Redis or in-memory fallback. |
| 7 | **User verification (biometric/PIN)** | `verifyAuthentication` uses `requireUserVerification: true`. | Correct — this is what makes it "step-up". |
| 8 | **Cloned-authenticator/concurrent assertion detection** | Counter is updated from `authenticationInfo.newCounter` only when the stored expected counter still matches. | Correct. |
| 9 | **No passkey registered** | Returns `NO_PASSKEY`; the UI tells the user to add one in Control Room. | By design — a user with no passkey cannot approve financial execution. |
| 10 | **Token/secret leakage** | No token/hash/link or credential material is returned or logged; challenge and credential tables are server-only; legacy stored refresh tokens are purged. | Safe. |

## Residual items (need a human)

- **Manual authenticator test**: register a passkey, create a
  FINANCIAL_EXECUTION approval, and confirm the full ceremony sets
  `step_up_verified_at` and that `isActionable` then permits execute; confirm a
  denied/cancelled ceremony does not.
- **Independent security sign-off** before enabling any real execution behind
  the gate (today the execute path only records clearance — no side effect).
