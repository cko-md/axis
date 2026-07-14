# 06 — Design system: semantic status tokens

- Status: partial (semantic status layer only)
- Wave: Phase 6.2

This program did **not** re-do the AXIS visual language (typography, motion,
surfaces, full token overhaul) — the existing system is retained. What it adds is
a small, consolidated **semantic status token** layer for the new operate
surfaces, so status color is coherent and lives in one place.

## The tokens

`src/lib/design/statusTokens.ts` — `SemanticToneKey` → CSS var:

| Token | Value | Used for |
|---|---|---|
| `muted` | `var(--ink-faint)` | neutral / unknown / idle |
| `accent` | `var(--accent)` | active computation / selected |
| `success` | `var(--up)` | fresh / completed / positive |
| `warning` | `var(--clay-2, var(--gold-deep))` | delayed / waiting / caution |
| `alert` | `var(--clay)` | blocked |
| `danger` | `var(--down)` | stale / failed / destructive |

Values are existing theme variables — this **consolidates, it does not restyle**.
A unit test pins the values so the palette can't drift silently.

## Consumers (each keeps its own tone vocabulary, resolves to a token)

- **Freshness** (`FreshnessBadge` / `freshnessBadge.ts`): positive→success,
  caution→warning, negative→danger, muted→muted.
- **Task status** (`taskStatusView.ts`): active→accent, waiting→warning,
  blocked→alert, done→success, failed→danger, neutral→muted.
- **Approval** (`approvalCardView.ts`): negative→danger, caution→warning,
  neutral→muted; action-class tone escalates execution/destructive to danger.

## Not done (tracked)

Typography/motion/surface token overhaul, a documented component gallery, and
light/dark parity review across all modules remain future work; the existing
AXIS theme (Dark/Dim/Light/Slate) is unchanged.
