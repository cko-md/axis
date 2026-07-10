# Remaining PR Roadmap (post #177)

> Sequencing agreed 2026-07-09. Stay on **Vercel** — no Render migration.

## PR sequence

| # | Branch focus | Modules | Production gate |
|---|--------------|---------|-----------------|
| **2** | `cursor/debrief-pipeline-hardening-e353` | Debrief, Pipeline | Save/retry, AI fallback, reminder persist, board CRUD + stage edit |
| **3** | `cursor/command-widget-cards-e353` | Command | Cosmo/Common Ninja-style interactive widget cards, DnD polish |
| **4** | `cursor/literature-briefing-fund-e353` | Literature, Briefing, Fund | Supabase persistence, provider states, feed CRUD |
| **5** | `cursor/lab-modules-hardening-e353` | Vitality, Atelier, Vault, Library, Supper Club | Strava/Spotify, RLS, Supabase migration for local-only data |
| **6** | `cursor/apps-new-board-e353` | Apps / UrlModules | AI New Board plan + scaffold |
| **7** | `cursor/nav-promotion-e353` | `nav.ts` | Promote validated modules beta/lab → production after preview + Sentry |

Depends on **#177** (calendar, contacts, objectives, CLI, typography) merging first.

## Per-PR acceptance (vertical slice)

Each PR must pass: `npx tsc --noEmit` · `npm run test` · `npm run lint` · Vercel preview happy + error paths · post-preview Sentry check · manual checklist in PR body.

### PR 2 — Debrief + Pipeline
- Daily + weekly save with visible errors and retry
- AI debrief summary heuristic fallback (no fake “unavailable” as content)
- Reminder prefs in `user_preferences.debrief_reminder` + task dedupe
- Pipeline: `updateStage`, `moveStudy`, load retry, save loading, abstract due on cards, fix study-plan AI
- Signed-out: demo labeled, add buttons gated

### PR 3 — Command widget cards
- Richer tidbit/widget cards (interactive metrics, drill-in, motion)
- Freeform grid polish (column sizing, snap, empty states)
- Widget detail error/stale states from live API paths

### PR 4 — Literature / Briefing / Fund
- Literature: saved articles + custom topics → Supabase (remove silent localStorage)
- Briefing: feed add/remove, refresh errors, saved items
- Fund: configured/unconfigured per provider, quote failure UX

### PR 5 — Lab modules
- Vitality: Strava connect reliability
- Atelier: feed errors, pin persistence
- Listening Vault: Spotify auth; remove or gate video lounge
- Library: upload/delete/download RLS validation
- Supper Club: recipes + diet prefs migration

### PR 6 — AI New Board
- Product spec in PR + route scaffold + placeholder → working create/save slice

### PR 7 — Nav promotion
- Only modules with completed manual matrix on preview
- Update `statusReason` / remove beta badge per module

## Out of scope (unless new Linear issue)

- Render background workers / workflows
- Full push notification delivery for debrief reminders (Agenda task nudge is acceptable MVP)
- Mail/cache-first (separate Linear track per AGENTS.md §11)
