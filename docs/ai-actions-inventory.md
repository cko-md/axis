# AI Actions Inventory (AI-1)

> Phase 8 AI-layer groundwork. Maps every AI call site, the server modes they
> hit, and which ones send privacy-sensitive content — so a typed AI-action
> registry (AI-2), a migration of call sites onto it (AI-3), and a privacy pass
> (AI-4) can be scoped without re-discovering the surface each time.

## Server endpoints

| Route | Purpose |
|---|---|
| `POST /api/ai` | Multiplexed AI actions, dispatched by `mode` (see table below). |
| `GET /api/ai/status` | AI provider configured/unconfigured state. |
| `POST /api/signals-ai` | Dispatch signal classification (single + `mode:"batch"`), heuristic fallback server-side. |
| `POST /api/embeddings` | Note embedding upsert for semantic search (fire-and-forget; no-ops without `GEMINI_API_KEY`). |
| `GET /api/search/semantic` | Embeds the query + pgvector RPC; returns `503 semantic_unavailable` when embeddings unconfigured. |

Provider selection is per-user (`profiles.ai_provider`, default Gemini). All AI
calls degrade to a documented fallback when the provider is unconfigured or
errors — none should hard-fail the surrounding workflow.

## `/api/ai` modes

| mode | Called from | Sends to the model | Privacy-sensitive |
|---|---|---|---|
| `triage` | Mail `MessagePanel`, Dispatch | subject + **stripped mail body** (truncated ≤4000) | **Yes — email content** |
| `route` | Notes | note title + **note body** | **Yes — note content** |
| `summary` / `rewrite` | Notes | note body | **Yes — note content** |
| `debrief_summary` | Debrief | tasks/wins/challenges/calendar titles | **Yes — personal reflection + calendar** |
| `companion` / `chat` | Mascot, Console | user prompt + module context | Depends on prompt |
| `regimen` | Vitality (AIRegimenModal) | training/health inputs | **Yes — health data** |
| `flashcards` / `quiz` / `mindmap` | Notes/Literature study aids | source text | Content-dependent |
| `financeNarrator*` (jobs) | Fund | portfolio/holdings context | **Yes — financial data** |

## Privacy posture (AI-4 groundwork)

- **Sent to the AI provider by design** (user-initiated): mail bodies (triage),
  note bodies (route/summarize/rewrite/study aids), debrief reflections,
  health inputs (regimen), fund context (narrator). These leave the app to the
  configured LLM provider — acceptable as an explicit user action, but must be
  surfaced to the user and never *logged* (Sentry/console) or sent without the
  user triggering it.
- **Sentry rule (verified pattern across mail/dispatch/notes/schedule):** AI
  failures are captured with safe tags only (`area`, `op`, provider, status,
  normalized code) — **never** the prompt, body, or model response. Keep this
  invariant when adding AI calls.
- **No AI call should run on a render-critical path** without user intent (avoid
  silent per-item fan-out to the model).

## Recommended next steps

- **AI-2** — typed registry: one module (e.g. `src/lib/ai/actions.ts`) declaring
  each action's `mode`, input schema (zod), whether it sends sensitive content,
  and its fallback. Validate inputs at the boundary.
- **AI-3** — migrate the ~25 call sites onto the registry incrementally (highest-
  risk/privacy-sensitive first: triage, route, regimen, financeNarrator).
- **AI-4** — assert (test) that no AI route logs prompt/body/response; add a UI
  affordance noting when content is sent to the provider.

_Call sites (client, non-test):_ Debrief, Pipeline, Vitality (Workout/Regimen/module),
Literature, Mail (MessagePanel), Mascot, Control Room, Objectives, Notes, Search,
Console (+ CaptureBar), Vault, Agenda; libs `signals/scan`, `objectives/scan`,
`ai/router`, `fund/financeNarratorJobs`, and hooks `useTasks/useLiterature/usePeople/useSignals`.
