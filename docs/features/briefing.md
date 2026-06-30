# Briefing

Briefing is the daily knowledge intake module. It combines curated seed stories with user-saved RSS feeds and saved read/watch items.

## Current Production Boundary

- Saved items and feed subscriptions persist in Supabase through `briefing_saved_items` and `briefing_feeds`.
- Legacy browser-saved items are imported once when a signed-in user has no server rows.
- RSS reads use the shared feed cache and live-fetch stale/missing feed URLs.
- Feed discovery degrades gracefully when AI providers are missing or unavailable.

## Validation Checklist

- Add a feed, refresh, and confirm items load.
- Save and remove a story; refresh and confirm persistence.
- Force an invalid feed URL and confirm visible failure without crashing.
- Confirm no private feed content or tokens are captured in Sentry.
