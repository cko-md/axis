# 06 — Design system

- Status: complete for the redesign scope
- Waves: Phase 6.1–6.3

The redesign retains AXIS's established visual language while placing shared
typography, surfaces, motion, status, contrast, and focus behavior behind
semantic contracts. The semantic roles alias the active theme and Interface
Studio variables; they do not fork a second palette or font system.

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

## Typography, surfaces, and motion

`src/lib/design/systemTokens.ts` exports the supported CSS-variable names and
`src/app/globals.css` owns their values:

- typography roles for display, title, heading, body, small, label, micro, and
  code; family aliases are rebound at `body` so runtime Interface Studio and
  `next/font` choices remain authoritative;
- canvas, chrome, panel, raised panel, input, overlay, boundary, and shadow
  surface roles that resolve through each active theme;
- instant, fast, base, deliberate, and ambient durations plus standard, enter,
  and exit easing; reduced-motion collapses every semantic duration and removes
  ambient/loading movement;
- theme-safe foreground-on-accent and focus-indicator roles, with automated
  contrast coverage across Dark, Dim, Slate, Light, and every accent preset.

## Component and accessibility contract

The authenticated `/design-system` gallery renders the real shared components
and is documented in `component-gallery.md`. The Phase 6 contract includes:

- persistent command labels and busy state on loading buttons;
- named segmented-control groups with selection exposed beyond color;
- unique dialog titles, Escape/backdrop close, enabled-control focus trapping,
  and trigger focus restoration;
- destructive-action confirmation, visible async feedback, non-color status
  labels, decorative skeletons, and static reduced-motion fallbacks;
- responsive wrapping inside the AppShell at desktop, constrained, and mobile
  content widths.

The phase is additive: it standardizes shared primitives and the reference
gallery without attempting a cross-module visual rewrite. Module-specific
visual-regression coverage continues under Phase 12.
