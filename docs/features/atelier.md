# Atelier

Atelier is a lab module for language practice, personal style discovery, and moodboard capture.

## Current Production Boundary

- Language practice resources are curated links plus RSS-backed reading refreshes.
- Moodboard images persist to Supabase when the signed-in user has the `moodboard_images` table available.
- Resource pins persist through `useAtelierPrefs`.
- Schedule actions route through the existing Schedule API where available.

## Lab Constraints

- Atelier is not a general creative asset manager yet.
- Curated language/style sources are seed content, not a provider-complete catalog.
- Missing RSS sources or unavailable image persistence must show visible feedback and leave the rest of the module usable.

## Promotion Checklist

- Validate pin persistence after refresh.
- Validate moodboard add/reorder/delete with Supabase RLS.
- Validate RSS refresh failure state.
- Validate schedule handoff creates an event and surfaces failures.
- Confirm no new Sentry events on happy path after Vercel preview validation.
