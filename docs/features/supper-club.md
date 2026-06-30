# Supper Club

Supper Club is a lab module for recipe curation and personal meal ideas.

## Current Production Boundary

- Suggested recipes are curated seed content.
- Diet preference, saved recipes, and user-added recipes are stored in browser local storage.
- Storage failures are visible in the UI.
- Recipe cards open the canonical source through the in-app web viewer.

## Lab Constraints

- Supper Club is intentionally local-only today.
- Saved recipes do not sync across devices.
- There is no Supabase recipe table, file upload, nutrition provider, or grocery workflow yet.
- Seed recipe nutrition values are editorial metadata and should not be presented as live provider data.

## Promotion Checklist

- Add Supabase-backed recipes with owner-scoped RLS.
- Migrate local recipes into Supabase once per signed-in user.
- Add create/edit/delete/detail views with refresh persistence.
- Add visible provider/error states for any nutrition or grocery integrations.
- Confirm no new Sentry events on happy path after Vercel preview validation.
