# Security review — approval step-up (WebAuthn)

- Scope: wave 5.5 (`/api/approvals/[id]/step-up`, PATCH approve change, client
  ceremony) + wave 5.5-hardening.
- Reviewer: adversarial self-review (Claude). **Still required: an independent
  human security review and a manual test with a real authenticator** — WebAuthn
  ceremonies cannot be exercised in this environment.

## Threat analysis & findings

| # | Concern | Assessment | Action |
|---|---------|-----------|--------|
| 1 | **Self-attested step-up** (client claims `stepUpVerified: true`) | Was the original hole. | **Fixed** — boolean removed; `step_up_verified_at` set only after a verified assertion. |
| 2 | **IDOR** — verifying step-up on another user's approval | `loadApproval` + the update are scoped `user_id = auth.uid()`; the passkey lookup is scoped to the user + `credential_id`. | Safe. |
| 3 | **Foreign credential** — asserting with someone else's passkey | Passkey must match `user_id = auth.uid()` AND `credential_id = response.id`. | Safe. |
| 4 | **Challenge replay** | Challenge is one-time (deleted on use) and 5-min TTL. | Safe. |
| 5 | **Confused-deputy across the user's own approvals** — a challenge minted for approval A used to verify approval B | Both are the same authenticated user, so not a privilege escalation, but weak binding. | **Hardened** — challenge now carries `approval_id`; verify requires the challenge to match this approval (migration `20260714145829`). |
| 6 | **Brute force / abuse of verify** | No throttle originally. | **Hardened** — per-user rate limit (10 / 10 min), matching the login passkey route. |
| 7 | **User verification (biometric/PIN)** | `verifyAuthentication` uses `requireUserVerification: true`. | Correct — this is what makes it "step-up". |
| 8 | **Cloned-authenticator detection** | Counter is updated from `authenticationInfo.newCounter`. | Correct. |
| 9 | **No passkey registered** | Returns `NO_PASSKEY`; the UI tells the user to add one in Control Room. | By design — a user with no passkey cannot approve financial execution. |
| 10 | **Token/secret leakage** | No tokens or credential material in responses or logs; challenge table is server-only. | Safe. |

## Residual items (need a human)

- **Manual authenticator test**: register a passkey, create a
  FINANCIAL_EXECUTION approval, and confirm the full ceremony sets
  `step_up_verified_at` and that `isActionable` then permits execute; confirm a
  denied/cancelled ceremony does not.
- **Independent security sign-off** before enabling any real execution behind
  the gate (today the execute path only records clearance — no side effect).
- Consider requiring step-up freshness (e.g. `step_up_verified_at` within N
  minutes of execute) rather than "ever verified for this approval".
