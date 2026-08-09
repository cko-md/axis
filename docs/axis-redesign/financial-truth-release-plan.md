# Financial truth and order-intent release sequence

FIN-003 and FIN-004 use an explicit expansion → application → contract
sequence. The two expansion migrations are safe for the currently deployed
application; the contract must not be applied until the exact compatible
application revision is Ready in production.

## Stage 1 — expansion

Apply and record only:

1. `20260723090000_net_worth_snapshots_authority_provenance.sql`
2. `20260809210000_fund_order_intents_and_execution_receipts.sql`

The first migration temporarily preserves the existing owner-scoped
`fund_connections` DML required by protected main. Its compatibility trigger
forces authenticated writes to `legacy_unknown`, so that path cannot mint
provider authority. The second temporarily preserves owner-scoped legacy
`fund_transactions` DML required by protected main. Its execution trigger
rejects any attempted `provider_verified` row without the immutable receipt and
intent chain. Neither compatibility path is a provider execution authority.
The expansion also retains protected main's budget, bank-transaction,
recurring, and holding conflict arbiters. Lineage-less recurring rows written by
an old worker remain explicitly non-authoritative. A legacy Make `delivered`
write is coerced to `accepted`, preserving availability without fabricating
delivery confirmation.

Before applying, capture the complete linked remote migration ledger and a
current recovery point. Apply each named transaction-wrapped file with a
multi-statement PostgreSQL client, mark only that exact migration version
applied, then capture the complete ledger again. Do not use `supabase db push`.

Required read-back:

- both versions are present exactly once in the remote migration ledger;
- all new columns, constraints, views, functions, and tables exist;
- provider publication RPCs and receipt materialization remain service-only;
- order intents and receipts are immutable;
- owner RLS remains owner-scoped;
- legacy connection writes are coerced to `legacy_unknown`;
- legacy transaction writes cannot create `provider_verified` execution;
- provider credentials remain absent from logs and evidence.

Before the expansion is applied, record aggregate-only checks for invalid
budget precision/range, duplicate manual-liability identities, duplicate
provider-holding identities, and legacy delivered outbox rows. Stop for a
non-zero invalid-budget or duplicate-identity count. Legacy delivered rows must
be reconciled by the documented `delivered` → `accepted` conversion and then
read back; they are not by themselves a stop condition. Separately record
holdings and liabilities grouped only by source; Stage 1 requires zero
non-manual holdings and zero non-manual liabilities because protected main can
still mutate those rows through its legacy owner routes. Record connection,
transaction, and detected-recurring row counts as aggregate values. Do not
exercise provider publication, promote an existing legacy snapshot, or create
a provider net-worth snapshot from preview while protected-main workers are
still live. The 18 current snapshots remain `legacy_unknown`; only a new exact
provider recomputation may create or promote current truth.

## Stage 2 — application

Merge the exact reviewed source revision, complete the protected generated-state
refresh, and wait for that exact source tree to be Ready in the Vercel
production project. Record the Git SHA, deployment ID and Ready timestamp,
authenticated Fund workflows, Vercel logs, and a post-traffic Sentry window.
Pause finance cron/provider publication and Make consumers for the short
application cutover, then wait past the maximum old request/job lifetime before
the contract. Retained protected-main uniqueness still forbids some new
multi-provider identities, including a provider holding that collides with a
manual symbol and provider transaction identities that collide with legacy
rows; publication stays disabled until the contract removes those arbiters and
its collision preflight passes.

The production smoke must prove:

- Plaid connection creation, status, sync, and disconnect use the service-role
  credential boundary;
- manual holdings and liabilities remain owner-scoped;
- allocation, concentration, reports, and net worth withhold unavailable or
  non-authoritative facts;
- the order ticket creates only an immutable `not_submitted` intent;
- refresh preserves the intent and creates no `fund_transactions` row;
- unknown actions and forged approval/submission attempts fail closed.

If any application check fails, leave the expansion schema in place, retain the
prior production application, and fix forward. Do not apply the contract.

## Stage 3 — contract

After the compatible production revision is Ready and healthy, create and
independently review the append-only contract migration. It must:

- remove `guard_fund_connection_expansion_compatibility`;
- remove `guard_make_outbox_expansion_compatibility` after all old workers are
  drained;
- remove the lineage-less detected-recurring compatibility branch from
  `guard_fund_recurring_transaction_authority`; every detected recurrence must
  carry authoritative provider lineage before publication resumes;
- stop the contract if any detected recurring row lacks `source_generations`
  or `source_generation_hash`, unless a separately reviewed non-fabricating
  quarantine or removal step reduces that aggregate count to zero;
- replace `fund_recurring_transactions_lineage_contract` so detected rows
  require a non-empty `source_generations` array and a 64-character lowercase
  hexadecimal `source_generation_hash`;
- remove the protected-main budget, bank-transaction, recurring, and holding
  conflict arbiters after the exact app is Ready, old workers are drained, and
  the aggregate collision preflight is clean; enable and observe new publishers
  only after this contract commits;
- drop owner insert/update/delete policies on `fund_connections` and revoke
  owner table DML while retaining only the safe display-column projection;
- drop owner insert/update/delete policies on `fund_transactions` and revoke
  browser DML;
- retain service-only publication, immutable intent/submission/receipt
  boundaries, the provider-verified execution guard, and owner SELECT;
- include an executable privilege, RLS, forgery, and existing-row read-back,
  including zero lineage-less detected recurring rows and denial of a direct
  service-role detected-recurring insert without lineage.

Apply the exact reviewed contract only after recording the live application SHA
and recovery owner. Immediately repeat the Fund authenticated smoke, direct-DML
denial probes, migration-ledger capture, Vercel log review, and Sentry review.
FIN-003 and FIN-004 close only after this contract stage and its protected state
refresh are complete.

Rollback is forward-only. Before contract, the application can roll back while
the compatible expansion remains. After contract, do not promote an older
application that depends on browser connection or transaction DML; use a new
reviewed recovery migration if emergency compatibility must be restored.
