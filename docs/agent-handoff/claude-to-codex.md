# Agent Handoff: Claude Code ↔ Codex (and other coding agents)

> Onboarding and active handoff note for AXIS work shared between Claude Code, Codex, and other coding agents.
> The durable, agent-neutral rules live in [`AGENTS.md`](../../AGENTS.md) at the repo root. This document is the orientation layer on top of it.

---

## 1. What Claude Code was previously used for

Claude Code has been the primary agent for AXIS so far. It produced the foundational analysis and early implementation that the rest of the roadmap builds on:

- The platform audit — [`docs/audits/axis-platform-audit.md`](../audits/axis-platform-audit.md) (platform map, UX/architecture/latency/integration findings, P0–P3 roadmap).
- The Linear-ready issue plan — [`docs/linear/axis-mvp-issues.md`](../linear/axis-mvp-issues.md) (initiatives, projects, milestones, per-issue specs + acceptance criteria + module order).
- The integration adapter foundation for Mail — [`docs/architecture/integration-adapters.md`](../architecture/integration-adapters.md) and `src/lib/integrations/*` + `src/lib/mail/adapters/*`. **This foundation is merged to `main`/production**, so module-priority item 1 is complete.

There is no root `CLAUDE.md`; durable guidance now lives in `AGENTS.md` so it is shared by every agent.

## 2. Why Codex is being added

To parallelize and de-risk delivery. Multiple agents (Codex, Claude Code, GitHub agents) can each take one Linear issue and run it through the same delivery system. For this to stay safe and consistent, every agent must follow the **same** repo instructions — hence `AGENTS.md` is agent-neutral and authoritative. The recurring failure mode being prevented: agents shipping UI that renders but doesn't complete the workflow (the Mail "lists but won't open detail" bug). Codex must build **complete vertical slices**.

## 3. How Codex should use `AGENTS.md`

- Read `AGENTS.md` in full **before** any task; it is the source of truth.
- Obey §2 (non-negotiable behavior), §3 (delivery workflow), and §12 (final response format) on every session.
- Respect the precedence order in §14 when instructions conflict (security/privacy → Linear scope → `AGENTS.md` → docs → existing code).
- Stay inside the scope of one Linear issue; split rather than expand.

## 4. How Codex should interact with the toolchain

- **Linear** — start from a specific issue (id + title); restate scope; do not exceed it. If no issue exists, request/create one or split the work.
- **GitHub** — branch from `main` (e.g. `codex/<area>-<slug>`); one issue per branch/PR; push/open the PR after local checks pass; PR description uses the §12 format and includes preview + validation evidence; never commit secrets.
- **Vercel** — every PR gets a preview deploy; validate the happy path **and** error path on the preview URL, not just locally; note the preview URL in the PR.
- **Supabase** — source of truth for data + auth (RLS). Inspect existing migrations before schema changes; new tables need owner-scoped RLS and `user_id`; state whether a migration is applied (don't assume prod).
- **Tembo** — role is **not yet documented**. Do not assume it is primary Postgres / analytics / queue / cache / unused. Inspect config and document findings; route nothing to it on assumption.
- **Sentry** — capture actionable failures with safe metadata only (provider, operation, status, transport, normalized code); never log tokens/bodies/OAuth payloads; review Sentry after the Vercel preview is available, not as a human pre-push gate; confirm the happy path produces no new Sentry error before production merge.

## 5. Current stacked PR state

Codex completed and pushed the Phase 0–3 stack plus the first Phase 4 Mail validation slice. These are draft PRs stacked one issue per branch; do not squash unrelated phases together while reviewing.

- Phase 0 docs/data truth stack: PRs #62–#67.
- Phase 1 theme/presence/render stack: PRs #68–#77.
- Phase 2 widget shell/UX stack: PRs #78–#85.
- Phase 3 widget data + Console/Command stack: PRs #86–#96.
- Phase 4 MAIL-1 provider parity validation: PR #97, branch `codex/phase-4-mail-1-provider-parity-validation`, latest commit `10d587f`.
- Phase 4 MAIL-2 inbox/message skeletons and detail retry state: PR #98, branch `codex/phase-4-mail-2-skeletons-detail-retry`, commit `65f9514`.

MAIL-1 adds a provider parity matrix for direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook; extends provider capabilities with `attachmentDownload`; relabels Mail attachment affordances as `Save to Library` only when direct byte download is supported and `Route via Dispatch` for Composio; and updates `docs/architecture/integration-adapters.md`.

MAIL-1 checks already run locally and passed: `npx tsc --noEmit`, `npm run lint`, `npm run test` (25 files, 189 tests), and `npm run build`.

MAIL-2 replaces text-only Mail loading states with structured status/inbox/message skeletons and adds a persistent message-detail error panel with Retry/Back that preserves safe provider/account/message context. MAIL-2 checks already run locally and passed: `npx tsc --noEmit`, `npm run lint`, `npm run test` (25 files, 189 tests), and `npm run build`.

## 6. Where Claude should resume

Resume from the next uncompleted issue after MAIL-2 and continue the full phase-based hardening plan sequentially:

1. MAIL-3: Premium message document viewer.
2. MAIL-4: Mobile action menu and keyboard pass.
3. MAIL-5: Theme and typography QA for mail reader.
4. DISP-1 through DISP-5.
5. AGENDA-1 through AGENDA-5.
6. CAL-1 through CAL-5.
7. NOTES-1 through NOTES-5.
8. Then continue through Phase 5 and every later phase from the initial project plan, in order, until the full AXIS hardening plan is complete.

Keep using one Linear issue → one branch → one PR. Branch from the current stack tip unless the user asks you to rebase onto another base. Do not merge or deploy production until preview validation, Supabase/Tembo validation, Sentry review, and manual workflow checks pass.

High-priority reminders for Phase 4:

- Mail work must validate both direct OAuth and Composio paths where provider accounts are available.
- Never log email bodies, tokens, raw OAuth payloads, or private content.
- If a provider/tooling secret is unavailable, implement visible degradation and record exact human validation steps instead of faking success.
- Preserve the adapter-driven route shape; route handlers should not reintroduce provider/transport branching.
- Every Daily module must satisfy list → detail → action → persistence → feedback → error state before it is treated as complete.

## 7. Copy-paste Claude continuation prompt

```txt
Read AGENTS.md, docs/agent-handoff/claude-to-codex.md, docs/architecture/integration-adapters.md, and the full initial phase-based hardening plan/pasted project plan if available.

Current stack status:
- Phase 0–3 are pushed as draft PRs #62–#96.
- MAIL-1 is complete and pushed as draft PR #97 on branch codex/phase-4-mail-1-provider-parity-validation, latest commit 10d587f.
- MAIL-2 is complete and pushed as draft PR #98 on branch codex/phase-4-mail-2-skeletons-detail-retry, commit 65f9514.
- MAIL-1 and MAIL-2 local gates passed: npx tsc --noEmit, npm run lint, npm run test, npm run build.

Continue through the whole phase-based hardening plan sequentially, one Codex/Claude-sized issue at a time:
- Start with the next uncompleted issue: MAIL-3, Premium message document viewer.
- After MAIL-3, continue MAIL-4, MAIL-5, then DISP-1..5, AGENDA-1..5, CAL-1..5, NOTES-1..5.
- After Phase 4, continue Phase 5 and every later phase from the initial plan in order.
- Do not skip ahead unless the plan explicitly says an issue is complete or blocked.

Follow AXIS rules exactly:
- one Linear issue → one branch → one PR
- build complete vertical slices, not visual prototypes
- preserve direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook parity
- do not log or expose email bodies, tokens, OAuth payloads, or private content
- provider/network/DB failures must be visible to the user and observable through safe Sentry metadata
- no schema changes unless a migration and RLS review are included
- hold production merge/deploy until explicit user approval and the preview/Supabase/Sentry/manual gates pass

For each issue:
- inspect the relevant files and current behavior before editing
- implement the complete vertical slice for that issue
- add focused tests where practical
- run npx tsc --noEmit, npm run lint, npm run test, and npm run build
- push the branch and open a draft PR stacked on the previous issue branch unless instructed otherwise
- include Vercel preview validation steps, Supabase/Tembo impact, Sentry validation requirements, and a manual checklist in the PR
- then proceed to the next issue in the plan

End with the required agent final response format from AGENTS.md.
```
