# VECTOR reusable prompt registry

Commit only reusable design/game asset prompts. Never store private user inputs,
secrets, provider responses, or generated binary payloads here.

Each entry in `manifest.json` records stable ID, version, purpose, tool/model,
source asset IDs, output paths/hashes, review status, and related wave. Game
titles and small UI copy remain DOM text, never generated into cover art.
