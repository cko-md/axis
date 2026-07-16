# Wave 15.0 — Program foundation

- Date: 2026-07-16
- Branch: `codex/vector-arcade-envoys`
- Baseline revision reviewed: `845bfac9`
- Status: landed

## Invariant

Planning may narrow implementation choices but cannot weaken supplied acceptance
criteria, safety rules, game completeness, worker deployment, private ownership,
or production validation. No concept image or document may be described as a
working feature.

## Planned and delivered

Delivered:

- current behavior and intended replacement;
- accepted deep pre-mortem with 21 binding mitigations;
- caveman simplification pass;
- dependency-ordered umbrella architecture;
- executable VECTOR and Envoy plans;
- ADRs for engine isolation, offline/sync/cache boundary, Envoy identity/mode
  separation, and worker topology;
- three VECTOR concepts, two card systems, selected console direction, cover-art
  direction, mobile/light adaptations;
- eight-Envoy concept sheet, truthful HUD concepts, Envoy Lab concept;
- controlled UX, game UI, high-end visual, premium frontend, Emil motion,
  anti-slop, accessibility, and reduced-motion synthesis;
- three generated concept sheets with reusable prompts and SHA-256 manifests;
- program state and verified open-defect records.

Not delivered or claimed:

- application code, routes, games, saves, sync, service worker, migrations, RLS,
  Envoy runtime, starter hatch packages, worker, OpenAI integration, Render
  deployment, browser QA, preview, Sentry, or production completion.

## Files

Added:

- `docs/axis-redesign/15-vector-arcade-and-envoys.md`
- `docs/axis-redesign/15-completion-matrix.md`
- `docs/vector/PLAN.md`
- `docs/envoys/PLAN.md`
- `docs/axis-redesign/adr/0004-vector-runtime-and-engine-isolation.md`
- `docs/axis-redesign/adr/0005-offline-save-sync-and-cache-boundary.md`
- `docs/axis-redesign/adr/0006-envoy-presence-and-mode-contract.md`
- `docs/axis-redesign/adr/0007-envoy-generation-control-and-execution-planes.md`
- `.logs/vector-envoys/INDEX.md`
- `.logs/vector-envoys/premortem.md`
- `.logs/vector-envoys/skill-preflight.md`
- `.logs/vector-envoys/design-review.md`
- `.logs/vector-envoys/wave-15.0-program-foundation.md`
- `.logs/vector-envoys/concepts/*.png`
- `.prompts/vector/*`
- `.prompts/envoys/*`

Changed:

- `.claude/axis-redesign/PROGRAM_STATE.json`
- `.claude/axis-redesign/DEFECT_LEDGER.json`

## Database, integrations, and security

No migration, schema, Storage, production data, provider call, or credential
change in this wave. Plans require owner RLS, narrow fixed-grant RPCs, private
Storage, lease fencing, DB-enforced quota, safe metadata, and applied-target
verification before production claims. Tembo remains unused pending evidence of
its role.

Verified existing defects added as open:

- `PREF-001`
- `RUN-002`
- `TASK-002`
- `STATUS-001`
- `AI-002`

## Design review

Selected Instrument Deck, Mission Plate, Save Strip, and Work Card. Generated
boards are internal evidence only. VECTOR board includes generated readable copy
despite the prompt's no-copy instruction; production UI remains DOM text. Envoy
UX board repeats a feline placeholder; production uses the selected Envoy
registry. Starter concepts still require hatch-pet rows and deterministic QA.

## Validation

Passed:

```text
jq empty .claude/axis-redesign/PROGRAM_STATE.json \
  .claude/axis-redesign/DEFECT_LEDGER.json \
  .prompts/vector/manifest.json \
  .prompts/envoys/manifest.json

git diff --check

shasum -a 256 .logs/vector-envoys/concepts/*.png
file .logs/vector-envoys/concepts/*.png
```

All images are 1536×1024 non-interlaced RGB PNGs. Hashes match prompt manifests:

- VECTOR: `66c3256e6d85d8e24958f2b51eb414be9990efb82fab54894fd0ce59818ca01b`
- Envoys: `dcbe90802f1ecfc8832281c56f5136d55fa72cc71722404ecec7be5d2c6e56cd`
- Envoy UX: `e680d2119f69fe71bc2eff89451a876b29b14ece1274e52f22f4ebdc7f982349`

Local Markdown link search found no unresolved relative links. Secret-pattern
search found no new credential material; one existing ledger sentence contains
the non-secret privilege result `service_role=true`.

No code gate was rerun because this documentation/asset wave changes no runtime,
dependency, test, migration, or build input. Phase 9 baseline remains 794 tests
across 124 files; Wave 15.1 reruns focused and full gates after integration.

## Review verdict

Pre-mortem quick re-check: pass. Every high risk maps to a wave, evidence, and
rollback/forward-fix posture. Caveman pass limited browser engines to one shared
Phaser path and one shared Three.js path, kept Second Sense engine-free, and
removed realtime-only correctness, client fan-out, and alternate worker paths.

Adversarial review found and repaired four validated defects:

- `PLAN-001`: restored binding Phaser requirement for Brickrise and shared
  route-isolated Phaser architecture;
- `PLAN-002`: expanded all nine game contracts instead of relying on compressed
  matrix rows;
- `STATE-001`: changed prospective landed status to in-progress/pending commit;
- `META-001`: added honest model provenance to every prompt manifest entry.

Orchestrator rereview: pass for Wave 15.0 scope. Program completion remains open.

## Next

Wave 15.1:

1. fast-forward canonical `c2de9308` retry-safe approval repair;
2. merge current `origin/main`;
3. inspect auto-merged Debrief and timezone preferences;
4. fix successful-read gating, envelope preservation, and expected-state races;
5. independently run focused tests, typecheck, lint, full unit suite, build, and
   performance budgets;
6. update this program evidence and commit one wave.
