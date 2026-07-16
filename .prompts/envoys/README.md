# Envoy reusable prompt registry

Commit bundled starter and design-review prompts only. User-created Envoy briefs,
references, intermediates, diagnostics, and outputs belong in private Supabase
Storage and must never enter Git, logs, Sentry, or Realtime payloads.

Each entry in `manifest.json` records stable ID, version, purpose, tool/model,
source asset IDs, output paths/hashes, review status, and related wave.
