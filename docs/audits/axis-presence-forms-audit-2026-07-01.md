# AXIS Presence Forms Audit

Date: 2026-07-01
Issue: PRESENCE-1 - Audit Axiom/Codex/Nova presence forms
Scope: `src/components/layout/Mascot.tsx`, companion CSS in `src/app/globals.css`, Interface Studio presence controls.

## Current Implementation

AXIS ships three selectable companion forms through Interface Studio:

- Axiom (`companion: "monolith"`): strategic advisor with focus tracking, a brief on open, and chat-style follow-up.
- Codex (`companion: "deck"`): contextual intelligence card deck with refresh, dismiss, and optional route actions.
- Nova (`companion: "nova"`): compact quick-question assistant.

All three render from `Mascot`, which is anchored fixed at the bottom-right of the viewport. Visibility is controlled by `interfaceSettings.presence`; dismissal writes `presence: "hide"` through the theme provider. After THEME-6, signed-in interface settings are intended to sync through `public.user_preferences.interface_settings`, with localStorage as the instant cache and signed-out fallback.

## Strengths

- The three forms have distinct visual identities and interaction models rather than being only cosmetic variants.
- Each form has keyboard activation on the figure, Escape-to-close behavior for the popout, loading states, and provider-failure fallback copy.
- Requests are aborted on Axiom unmount, reducing stale response risk.
- Companion context is intentionally small and module-scoped through `buildContext`, not a broad dump of user data.
- Reduced-motion handling exists for the most active SVG animations.

## Findings

### P1 - Popouts are not full dialogs

The popout shells are visually modal-like but do not expose dialog semantics, focus trapping, initial focus management, or focus restoration. Keyboard users can tab out behind an open companion. Screen readers only encounter nested content, not a named dialog.

Expected follow-up: PRESENCE-2 should give `PopoutShell` `role="dialog"`, `aria-modal` where appropriate, labelled titles, initial focus, Escape handling in one shared place, and focus restoration to the figure.

### P1 - AI failures are visible but not observable

Axiom, Codex, and Nova show local fallback messages when `/api/ai` fails, but the component does not capture unexpected client-side request failures in Sentry. This makes preview/prod regressions harder to distinguish from normal offline behavior.

Expected follow-up: PRESENCE-3 should capture unexpected companion request failures with safe metadata only: companion form, operation, route family, response status if available, and no user prompt/response text.

### P1 - Axiom focus is still localStorage-only

Axiom stores `axiom-focus` directly in localStorage, separate from Interface Studio persistence. This is user-authored preference/context and currently has no visible local-only label near the control.

Expected follow-up: move focus persistence into a scoped preference field or clearly label it local-only. Do not silently imply it syncs with the signed-in Interface Studio settings.

### P2 - Privacy boundaries are implicit

The request payload sends module/time context plus the user prompt and recent chat history. That is reasonable for the feature, but the UI does not disclose that companion prompts are sent to `/api/ai`, and there is no privacy affordance near the input.

Expected follow-up: add concise privacy state in the popout chrome or input area. Avoid long instructional copy; a compact status badge or tooltip is enough.

### P2 - Mobile behavior is underspecified

The companion anchor is fixed bottom-right, and popouts have fixed widths of 280-360px. This may fit many phones, but there is no explicit mobile rule for viewport padding, max height, bottom safe area, or preventing the popout from covering navigation-critical UI.

Expected follow-up: PRESENCE-2 should add mobile-specific sizing and safe-area rules, then validate at 390px and 430px widths.

### P2 - Visual parity across themes is unverified

The companion forms use shared tokens, but Nova still carries hard-coded blue values and Axiom/Codex rely on older gold/marine assumptions. The forms likely work, but they have not been validated against dark, dim, slate, and silver/chrome light with chrome/marine/clay accents.

Expected follow-up: theme-specific QA and minor tokenization where hard-coded color weakens light-theme legibility.

### P2 - Motion policy is incomplete

Several SVG animations are disabled in `prefers-reduced-motion`, but hover transforms, popout entrance, skeleton shimmer, typing bounce, and card fade still animate.

Expected follow-up: expand reduced-motion coverage for all companion transitions and loading animations.

### P3 - Dismiss and restore labels are minimal

Dismiss controls use title text but no explicit `aria-label`. The restore button title is understandable visually but should use an accessible label too.

Expected follow-up: add `aria-label` to dismiss/restore controls and make the chosen companion name available to assistive tech.

## Form-by-Form Notes

### Axiom

Axiom is the strongest product fit: a persistent focus plus strategic brief matches AXIS's command-center identity. Its main risk is privacy/persistence clarity. The focus field feels like account state but is currently browser-local. It also sends focus into the AI prompt; that is acceptable only if the UI makes the networked AI boundary clear.

### Codex

Codex has the clearest non-chat workflow: card deck, refresh, dismiss, and route action. It should become the pattern for module-aware suggestions. Its current risk is action quality: cards only route when `actionPath` is present, and the empty/offline states are simple but adequate.

### Nova

Nova is lightweight and useful as a quick oracle, but it overlaps with Axiom chat. Its product role should stay intentionally narrow: one-shot question, no persistent memory, no task routing. The blue visual treatment is memorable but needs theme/accent QA.

## Recommended Follow-Up Issues

- PRESENCE-2: Implement shared companion dialog accessibility, mobile sizing, reduced-motion coverage, and theme QA.
- PRESENCE-3: Add companion AI privacy states, safe Sentry observability, and persistence clarity for Axiom focus.

## Validation Performed

- Static code inspection of `src/components/layout/Mascot.tsx`.
- Static CSS inspection of companion styles in `src/app/globals.css`.
- Interface Studio setting flow inspection through `src/components/theme/InterfaceStudioDrawer.tsx` and `ThemeProvider`.

No authenticated browser QA was performed in this audit branch.
