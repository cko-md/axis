# Agent Handoff: Claude Code → Codex (and other coding agents)

> Onboarding note for adding Codex (and any other coding agent) to AXIS alongside Claude Code.
> The durable, agent-neutral rules live in [`AGENTS.md`](../../AGENTS.md) at the repo root. This document is the orientation layer on top of it.

---

## 1. What Claude Code was previously used for

Claude Code has been the primary agent for AXIS so far. It produced the foundational analysis and early implementation that the rest of the roadmap builds on:

- The platform audit — [`docs/audits/axis-platform-audit.md`](../audits/axis-platform-audit.md) (platform map, UX/architecture/latency/integration findings, P0–P3 roadmap).
- The Linear-ready issue plan — [`docs/linear/axis-mvp-issues.md`](../linear/axis-mvp-issues.md) (initiatives, projects, milestones, per-issue specs + acceptance criteria + module order).
- The integration adapter foundation for Mail — [`docs/architecture/integration-adapters.md`](../architecture/integration-adapters.md) and `src/lib/integrations/*` + `src/lib/mail/adapters/*`.

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
- **GitHub** — branch from `main` (e.g. `codex/<area>-<slug>`); one issue per branch/PR; PR description uses the §12 format and includes preview + validation evidence; never commit secrets.
- **Vercel** — every PR gets a preview deploy; validate the happy path **and** error path on the preview URL, not just locally; note the preview URL in the PR.
- **Supabase** — source of truth for data + auth (RLS). Inspect existing migrations before schema changes; new tables need owner-scoped RLS and `user_id`; state whether a migration is applied (don't assume prod).
- **Tembo** — role is **not yet documented**. Do not assume it is primary Postgres / analytics / queue / cache / unused. Inspect config and document findings; route nothing to it on assumption.
- **Sentry** — capture actionable failures with safe metadata only (provider, operation, status, transport, normalized code); never log tokens/bodies/OAuth payloads; confirm the happy path produces no new Sentry error.

## 5. Current module priority order

Follow `AGENTS.md` §11 / `docs/linear/axis-mvp-issues.md`:

1. Integration adapter foundation → 2. Mail: Composio Gmail detail → 3. Mail: Composio Outlook detail → 4. Mail visible error state → 5. Mail reply/send parity → 6. Mail archive/delete/mark-read → 7. Mail pagination/load-more → 8. Mail cache-first → 9. Latency pass → 10. Env/Sentry/Vercel gate → 11. Dispatch → 12. Agenda → 13. Schedule/Calendar → 14. Control Room → 15. Console/Command → 16. Navigation/IA → 17. Notes → 18. People → 19. Literature → 20. Pipeline → 21. Objectives → 22. Debrief → 23. Briefing → 24. Fund → 25. Vitality → 26. Library → 27. Atelier → 28. Listening Vault → 29. Supper Club → 30. AI layer → 31. Final production readiness.

## 6. First recommended Codex task

**"Mail: Composio Gmail messages open into readable detail."**

This is the highest-value entry point: the adapter foundation already exists, and this issue completes the most visible broken workflow (Composio Gmail inbox rows that don't open into a readable message). Verify against the full Mail matrix in `docs/architecture/integration-adapters.md` (direct Gmail, direct Outlook, Composio Gmail, Composio Outlook × list/detail/send/actions/error states).

## 7. Copy-paste Codex starter prompt

```txt
Read AGENTS.md, README.md, docs/linear/axis-mvp-issues.md, and the relevant Mail files.

Execute only the Linear issue:
“Mail: Composio Gmail messages open into readable detail.”

Follow the delivery system:
Linear issue → branch → implementation → PR → Vercel preview validation → Supabase/Tembo validation → Sentry check.

Do not work on unrelated modules.
Do not refactor broadly.
Do not expose secrets.
End with the required agent final response format from AGENTS.md.
```
