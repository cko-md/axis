# Owner-Controlled Merge Root

## Why this exists

AXIS is a public repository owned by one GitHub user. GitHub branch protection
can bind a required context to an App, but it cannot bind that context to one
exact workflow in this repository. Another workflow running as the GitHub
Actions App can emit the same context. Therefore
`.github/workflows/release-governance.yml` is useful base-controlled evidence,
not merge authority.

The temporary authority root is `scripts/owner-merge.mjs`, executed locally by
the repository owner from an independently pinned trusted artifact. It is
never run by GitHub Actions, Vercel, candidate code, or candidate dependencies.
The longer-term replacement is an organization required workflow or a custom
GitHub App whose check identity and policy are independently controlled.

`main` must already have both `lock_branch=true` and admin enforcement enabled,
plus the exact numeric repository ruleset supplied to the command. That ruleset
must be active, have no bypass actors, target only `refs/heads/main`, and carry
the complete canonical owner-merge contract. The executor never discovers or
selects a ruleset by name.
The executor never unlocks `main`. Before its second complete evidence read or
any protection mutation, it durably writes a `PREPARED` journal record bound to
the trusted controls, remote snapshot, external evidence digest, inert
candidate validation, and exact approval. It then temporarily disables only
admin enforcement, submits one exact-head squash merge, and restores/read-backs
admin enforcement in `finally`. If any identity, principal, SHA,
workflow/run/attempt/job, App binding, preview, SBOM, review thread, evidence
hash, or protection field is wrong, it fails closed.

## Bootstrap is not self-authorizing

The first PR contains the executor itself, so neither that candidate nor a
candidate-reported digest authorizes its own merge. Node necessarily loads the
executor and its import graph before any in-process self-check can run.
Therefore bootstrap trust begins **outside the process**: before launch, an
independent reviewer/operator must verify the exact full SHA and control digest
of a separately pinned clean detached artifact, then invoke that already
verified artifact with a trusted local Node/Git/`gh`/`tar`/`unzip` toolchain.
The reviewer writes a report outside the repository. The owner records that
report's SHA-256 in the external evidence file using
`trustedReview.kind: "independent-bootstrap-review"`.

For every later merge, the executor must run from the exact current protected
`main` SHA and `trustedReview.kind` is `protected-main-review`. It validates the
candidate as inert Git data with trusted-base code. It does not check out or
execute candidate hooks, submodules, Actions, dependencies, package scripts, or
shell commands.

The installed executor also freezes and rejects changes to its own control
plane. Replacing it (for example with the future custom App authority) requires
a separately reviewed and externally pinned one-time break-glass artifact; an
ordinary candidate cannot ask this executor to authorize its replacement.

## One-time hosted binding before bootstrap merge

The bootstrap cannot depend on the newly introduced
`release-governance` workflow, because that workflow does not exist on its base.
The hosted CI and runtime-dependency gates do exist and must be bound before the
owner exception:

1. Observe the successful `pull_request` CI run for the exact bootstrap head.
2. Query the exact `runtime-dependency-audit` check run and verify
   `app.id == 15368`, `head_sha` equals the bootstrap head, and
   `conclusion == "success"`.
3. From the independently pinned trusted artifact, create the repository
   ruleset with the committed canonical payload — never reconstruct it from
   prose — and record the numeric ID returned by GitHub:

   ```bash
   gh api --method POST repos/cko-md/axis/rulesets \
     --input scripts/owner-merge-ruleset.json
   ```

   [`owner-merge-ruleset.json`](../../scripts/owner-merge-ruleset.json) is the
   single auditable creation payload. Its exact name is
   `axis-main-production-gate`; it is active, no-bypass, main-only, has no
   `update` rule, and contains exactly five rules.
4. Its pull-request rule must use zero approving reviews with stale-review
   dismissal on, code-owner and last-push approval off; its strict status-check
   rule must set `do_not_enforce_on_create=false` and contain exactly the five
   App-15368 contexts (`docs-currency`, `verify`, `e2e-smoke`,
   `e2e-authenticated`, `runtime-dependency-audit`) plus
   `Vercel Deployments – CKO's projects` from App 8329.
5. Read branch protection, that exact numeric ruleset, and the effective active
   rules back. The effective endpoint must return exactly those five rules,
   all sourced from that ruleset ID and repository:

   ```bash
   gh api 'repos/cko-md/axis/rules/branches/main?per_page=100'
   ```

   Do not merge if a rule, actor, check, source, parameter, or ref condition is
   missing, disabled, broadened, duplicated, paginated, or unexpected. Keep
   `lock_branch=true` and admin enforcement enabled.

The executor independently repeats the binding check and inspects the exact
run's downloaded `runtime-sbom` artifact before it can enter its critical
section. After bootstrap lands, observe the first genuine base-controlled
`release-governance` result and record it as defense-in-depth evidence. Do not
add its forgeable shared-App context as a required branch status on this
user-owned repository.

## Evidence file

The external file must satisfy
[`scripts/owner-merge-evidence.schema.json`](../../scripts/owner-merge-evidence.schema.json).
It and every referenced artifact must use absolute paths outside the trusted
worktree. The evidence file and attachments are opened with no-follow
descriptor semantics, validated by descriptor/inode against their canonical
out-of-tree paths, read from those descriptors, and checked again after the
read. A path replacement therefore cannot substitute the bytes being hashed.
Every artifact has a caller-supplied SHA-256 which the executor recomputes.

`vercelPreview` must contain the exact deployment, project, team, and head plus
Vercel's numeric `createdAt` and `ready` values (recorded as `createdAt` and
`readyAt`). The executor requires `readyAt >= createdAt` and exact equality
with the independently fetched v13 deployment response. The required manual
check IDs are:

- `vercel-preview`
- `application-happy-path`
- `application-error-path`
- `persistence-after-refresh`
- `authorization-and-rls`
- `github-app-installation-permissions`
- `vercel-log-secrets-review`
- `supabase-and-tembo-impact`

The `github-app-installation-permissions` artifact is mandatory and hash-bound
like every other manual artifact. It must be a timestamped, reviewer-identified
readback for the exact `cko-md/axis` repository from GitHub's installed-app
settings. It must inventory every installed GitHub App with repository access,
record whether access is all repositories or selected repositories, record the
displayed repository permission levels for each installation, and include the
reviewer's explicit conclusion that no unexpected App can bypass governance or
write/administer this repository. Preserve the settings readback (for example,
screenshots plus a text inventory) outside the trusted worktree and place the
SHA-256 of that exact artifact in this check's `artifact.sha256`. A prose claim
without the settings readback, a repository integrations list without each
installation's permission detail, or an omitted App is a failing artifact.

Manual validation must complete at or after the preview's Ready timestamp.
Sentry evidence must begin no later than preview creation, remain open through
both preview Ready and manual-validation completion, be reviewed after the
evidence window closes, report zero new issues and zero unresolved regressions,
and reference a hash-verified report. Evidence reports must not contain
credentials, tokens, private content, or raw provider payloads.
Attachment hashes prove that the bytes reviewed are the bytes supplied; they
do not cryptographically prove the truth of the report's human conclusions.
This temporary threat model trusts the owner/operator boundary and the recorded
independent review. It does not describe those assertions as third-party
attestation.

## Trusted preparation and dry run

Use Node 24. Prepare an isolated clean worktree at the independently reviewed
full SHA. Trusted dependencies may be installed with lifecycle scripts
disabled; candidate dependencies are never installed:

```bash
npm ci --ignore-scripts
node scripts/owner-merge.mjs \
  --print-control-digest \
  --trusted-sha="$TRUSTED_FULL_SHA"
```

Compare the printed digest with the independently recorded digest. Do not
derive both sides of the comparison from the candidate in the same review
step.

The operational command is intentionally verbose. Every identifier is pinned:

```bash
node scripts/owner-merge.mjs \
  --bootstrap \
  --repository-id="$REPOSITORY_NUMERIC_ID" \
  --ruleset-id="$MAIN_RULESET_NUMERIC_ID" \
  --owner=cko-md \
  --name=axis \
  --pr="$PR_NUMBER" \
  --head-sha="$EXACT_PR_HEAD_SHA" \
  --trusted-sha="$TRUSTED_FULL_SHA" \
  --trusted-control-digest="$INDEPENDENT_CONTROL_SHA256" \
  --ci-workflow-id="$CI_WORKFLOW_NUMERIC_ID" \
  --ci-run-id="$CI_RUN_NUMERIC_ID" \
  --ci-run-attempt="$CI_RUN_ATTEMPT" \
  --vercel-deployment-id="$PREVIEW_DEPLOYMENT_ID" \
  --vercel-project-id="$VERCEL_PROJECT_ID" \
  --vercel-team-id="$VERCEL_TEAM_ID" \
  --evidence="$ABSOLUTE_EXTERNAL_EVIDENCE_JSON"
```

Omit `--bootstrap` after the one-time bootstrap. Dry-run is the default and
performs no mutation. It must print `DRY_RUN_PASS` for the exact current remote
state before the owner considers mutation.

## Explicit owner mutation

Mutation requires both `--execute` and the exact documented approval phrase,
plus an absolute nonexistent receipt path in an existing, directly named
non-symlink directory outside the trusted worktree:

```bash
node scripts/owner-merge.mjs \
  ...the exact dry-run arguments... \
  --execute \
  --approval-phrase="I APPROVE THE EXACT AXIS OWNER MERGE" \
  --receipt="$ABSOLUTE_NEW_RECEIPT_JSONL"
```

The executor inventories collaborators and deploy keys and refuses any
unexpected write/admin principal or any deploy key. It verifies the owner/admin
`gh` identity, the exact public `cko-md/axis` repository identity with
`default_branch=main`, read-only workflow defaults, the exact current base/head,
mergeability and resolved review state, the exact numeric CI workflow, run
attempt, and positive check-suite ID; every required App-15368 check must have
that exact suite ID, alongside all five successful App-15368 jobs, every
app-bound required check, the required App-8329 Vercel branch-protection
binding, and the latest
`Vercel Deployments – CKO's projects` plus `Vercel` commit statuses. Those
statuses must come from the exact `vercel[bot]` identity; the aggregate target
must contain the exact repository/branch/head and the deployment target must
contain the exact deployment-ID suffix. The executor separately reads the
Vercel API and requires that deployment to be the exact Ready
team/project/preview/head. It also validates the runtime SBOM, Sentry evidence,
the exact configured ruleset and its effective active rules, and manual
evidence, then performs the entire remote read a second time.

After the initial read, evidence validation, and inert candidate validation,
the executor canonicalizes and opens the receipt parent with no-follow
semantics. It then exclusive-creates the receipt journal at mode `0600`,
retains both file and parent descriptors, writes one secret-free JSON Lines
`PREPARED` record, and fsyncs the file and parent directory. Creation or either
fsync must succeed before the merge callback can run. The record contains only
identifiers, timestamps, and hashes; it never contains tokens, attachment
contents, or provider responses.

Only after the durable `PREPARED` record and the agreeing second remote read
does it delete the legacy admin-enforcement endpoint. With `main` still locked
and the no-bypass ruleset still active, it performs complete admin-off snapshot
A: identities/principals, protection/ref/PR/reviews, CI workflow/run/attempt/
jobs/suite/check runs/artifact, commit statuses, Vercel API deployment,
external evidence and trusted root, and both configured and effective rules.
It appends and fsyncs a secret-free `CRITICAL_VERIFIED` record bound to A and
the agreeing second snapshot.

The fsync is deliberately not the last operation before merge. The executor
then performs the same complete admin-off snapshot B and requires B to match A
canonically, including evidence/trust digests, before immediately sending the
exact head SHA with `merge_method: "squash"`. A newly submitted
`CHANGES_REQUESTED` review, pending review, unresolved thread, hosted-gate
change, evidence replacement, or direct/effective governance drift before B
completes aborts before `PUT /merge`; `finally` restores admin enforcement.
GitHub exposes no atomic read-and-merge operation for this owner exception, so
a change after snapshot B but before GitHub accepts the merge remains a
residual service race. In `finally`, it retries
re-enabling admin enforcement and requires a complete protection read-back.
After the merge it
verifies the returned SHA, new `main`, single parent, tree equality with the
reviewed PR head, squash topology, `merged_by` owner, and the restored
normalized configured and effective rules.

The successful receipt is an append-only three-record JSON Lines journal:
`PREPARED`, `CRITICAL_VERIFIED`, then `MERGED`. A known pre-merge validation
failure has `PREPARED` followed by `ABORTED`; a failure after the critical
record has `PREPARED`, `CRITICAL_VERIFIED`, then `ABORTED` or
`RECONCILIATION_REQUIRED`. If the `CRITICAL_VERIFIED` append or fsync itself
fails, the executor sends no merge `PUT` and best-effort seals the journal with
only its durable `PREPARED` record; that write-failure case cannot safely append
an `ABORTED` claim to the same damaged journal. The executor otherwise appends through the retained
descriptor, fsyncs the outcome, changes the file to mode `0400`, fsyncs the
metadata and parent, and then closes both descriptors. An existing path can
never be overwritten. A known failure before GitHub accepts the merge records
only a safe failure code and `ABORTED`; raw `gh`, token, and provider error
content is never journaled. An ambiguous request or post-merge verification
failure records `RECONCILIATION_REQUIRED`.

If the process crashes or the final append/fsync/chmod fails, `PREPARED` is the
initial reconciliation anchor and a present `CRITICAL_VERIFIED` record proves
the last complete admin-off state that snapshot B had to match before PUT. On a
caught finalization failure the executor also makes a best-effort
fsync/read-only seal without overwriting or truncating the journal. Treat the
command as having an unknown merge outcome: inspect the exact PR, `main`, merge
commit, configured/effective rules, and branch protection against those
digests, then append nothing by hand. Preserve the original journal and create
a separate signed/operator reconciliation report.
A restoration failure is a critical incident; stop all release work and
restore branch protection before doing anything else.

Evidence timestamps are bounded by the executor's injected current time plus a
documented five-minute clock-skew allowance. This applies to the Vercel
timestamps recorded in the evidence, trusted-review time, every Sentry time,
and manual completion. The exact preview-Ready → manual-completion → Sentry
window/review ordering remains mandatory.

## Filesystem boundary and residual limits

This control assumes a local POSIX filesystem with working `O_NOFOLLOW`, file
and directory `fsync`, stable inode/device identities, and durable-storage
semantics appropriate to the release record. Node does not expose Linux
`openat2` path-resolution constraints portably. The executor compensates by
holding the canonical parent descriptor, creating only with
`O_CREAT|O_EXCL|O_NOFOLLOW`, and checking the opened inode against the
canonical path before and after I/O. A same-UID process or root can still
rename/unlink files or directories, and some network/virtual filesystems or
storage hardware can weaken `fsync` guarantees. Use an owner-controlled local
directory on a durable filesystem; do not use a shared or network-mounted
receipt directory.

GitHub's user-token REST surface does not provide a complete, authoritative
inventory of every installed App that might hold repository permissions. The
executor does not claim otherwise. It rejects branch-protection PR bypass
allowances and keeps the branch locked, which constrains ordinary App writes,
but the owner must complete the hash-bound
`github-app-installation-permissions` settings readback described above before
approval. A future custom authority App should make that
installation/permission inventory part of its controlled policy boundary.
