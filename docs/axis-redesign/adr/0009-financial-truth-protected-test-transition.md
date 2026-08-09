# ADR 0009 — One-use protected-test transition for financial truth

- Status: pending exact-head independent review and owner authorization
- Date: 2026-08-09
- Scope: FIN-003, FIN-004, and the Plaid financial-input boundary only
- Required authorization phrase: `I APPROVE THE EXACT FINANCIAL TRUTH PROTECTED TEST CONTRACT TRANSITION`

## Exact protected blobs

| Protected test | Base blob | Candidate blob | Base SHA-256 | Candidate SHA-256 |
|---|---|---|---|---|
| `src/lib/brokerage/publicOrderAdapter.test.ts` | `9121ba3886b19b005d1e7e7eb866fa566ef53702` | `4978d3c764da238360043de8d3bdaa1d9ebfb8a7` | `9749e318ec5a48bf5d17a731e3b29efc85be61855fff691830036ec64fbed8d9` | `684639d4a819663243ac1946b9b3d567529cb13adf9de3a6d841484b9cbffa4a` |
| `src/lib/fund/provenance.test.ts` | `11b9c87035c3a333bcc0e239f809580d9d31ed1f` | `b585b9f059393c978d9e4d0e65767a3b351156b0` | `679d0c6f26088bd7e9c6b666f9f4c5e0f689164afc2f9f081db55f91c5d48b4b` | `229a5f4c6a5ae160af61af92bd59176b92ccce11acce8c5e71604ce0dd9e7f33` |
| `src/lib/fund/reconcileHoldings.test.ts` | `f3730523a5b5035c11c694c3605c32bf304a1b8f` | `971d307a63f15772eb4d1c6cac43ebcd4336e9fb` | `01b6c8f1686899db3a4baa40e6d9d6b6c6a396c8cc5feac473b7f5ec03814ce5` | `39660feeb6129829a6e15d08e611c1b2cf86bf09f8ad74f855c47a4df7eedf55` |
| `src/lib/orders/orderTicket.test.ts` | `1e267cd2fcb27390d734c6ad92686846aeb0eb10` | `2ef4abd826d48cf7afd3a6b3e103f7a144171f41` | `aa44da28c5121d44f02d89556266c23b8c7fa10110c8584c5dd46ee800a6b773` | `34a213e822cd2e079cb81b46523b43dffca50e2166b88ecc6ab47d5afc01373d` |
| `src/lib/plaid/account.test.ts` | `1b65123bc3327bc8fe65dbce5703acb3fda11efb` | `6157e2db04eaca3ded2d59796e558eaa5b861a8e` | `e21f5b068e38db1b68df1d872481054d62072aa62be6fe487ad0e83fad798456` | `b12023b789ceadd6f6782e051a92ce219f616184d01944c322881cd211bf3c50` |
| `src/lib/plaid/adapter.test.ts` | `81d362af5cf6414c9d1bc1c75cf3f1ad03603242` | `9e5a9192e01d2748112838f03662c4eca1bdc7be` | `65ed6c06817181af44b415d135b9c8a3b1168568e29709147fc945948215f796` | `94d792c4bdb849fb896221447fe69e7062b5a6cf37c840b94877655231648634` |
| `src/lib/plaid/liability.test.ts` | `b88c71651a3db02c5501f04d10f6839296a15021` | `03b1187c2d96dd1d167ae0bd56739014063014ad` | `52b61f3d2cf2be9242de364dbe1246ed2dfab8013708aa6d75d364d35376c533` | `468c5b6b0e6505ef4beb22625c89624fd2abbdba4681a269b1eef95cbd95839f` |
| `src/lib/plaid/transaction.test.ts` | `0ead9ba72c6080e90fae9a8d852f1eae6b77ecdd` | `bb6022814321445bbb9be99adafff656b7207537` | `3cfb1ac2014c8eb0e936e500f75dab7d9b164dbb3859ca83e35ad8468fe1d872` | `9bf5ebdc17672d1b56c78df46ad9587b79382de129438d86bb57f3969aac0ee8` |

`marketReport.test.ts` and `concentrationCheck.test.ts` remain byte-identical to
protected main. Their new authority coverage lives only in additive
`*.fault.test.ts` files.

## Decision

Accept the eight exact test-blob transitions above as a single one-use
financial-contract correction. The changes do not weaken matchers, skip tests,
reduce coverage, or introduce environment-dependent behavior. They replace
stale permissive assumptions with the following explicit contract:

- every order ticket supplies its currency;
- reconciliation supplies the currency used to interpret minor units;
- a missing holding currency remains unavailable instead of becoming USD;
- Plaid accounts, liabilities, and transactions fail closed when provider
  currency is absent;
- provider money that is not exactly representable at the declared currency
  precision is rejected instead of rounded, nulled, or coerced;
- Plaid adapter fixtures bind persistent connection identity, provider Item
  identity, distributed admission, complete pagination metadata, and explicit
  provider currency.

## Threat analysis

Keeping the base assertions would require runtime compatibility branches that
silently invent USD, accept ambiguous float precision, omit provider-account
identity, or bypass distributed admission. Those branches would recreate the
FIN-003 authority defects the candidate is intended to remove. Test-only caller
detection, environment switches, skipped assertions, and relaxed matchers are
forbidden.

The transition remains risky because protected tests are part of the trusted
release baseline. It is therefore limited to the listed blobs. All other
protected tests, package scripts, workflows, owner-merge controls, deployment
configuration, and toolchain inputs must remain byte-identical to protected
main. Additive fault tests remain subject to ordinary review.

## One-use external executor requirements

An independently pinned executor must verify the exact protected base SHA,
candidate SHA, eight base/candidate blob pairs, and this ADR before running any
candidate code. It must reject any additional protected test or control-plane
delta. Two read-only reviewers must independently verify the financial
fail-closed semantics and the expansion/application/contract migration
sequence. The complete focused suite, disposable database validators, one
committed-state full gate, exact-head CI, Vercel preview, authenticated workflow
replay, logs, Sentry window, and migration evidence must be green.

The acceptance envelope expires after 24 hours or one merge attempt. It is not
the merge authorization itself; the exact candidate still requires the normal
owner merge authorization and evidence. Any source, protected-test, migration,
manifest, or ADR change invalidates the envelope and requires fresh hashes and
review.

After the single permitted attempt, the executor must destroy or
cryptographically invalidate the one-use acceptance envelope, retain a
sanitized immutable receipt, and destroy any secret-bearing execution journal
after protected-branch and ruleset restoration has been independently
verified.

## Rollback

Before the database contract, abandoning the candidate restores the eight base
blobs with the protected source. After contract, the permissive base tests must
not be restored without an explicit recovery migration and a new review: doing
so would pressure runtime code to reintroduce fabricated currency or ambiguous
money coercion.
