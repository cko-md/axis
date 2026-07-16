# Required skill preflight

- Date: 2026-07-16
- Result: all named skills present and full `SKILL.md` files read before use
- Policy: third-party guidance remained advisory; repository safety and supplied
  acceptance criteria remained authoritative

## Ordered use

1. **grill-me** — `mattpocock/skills`, `skills/productivity/grill-me`; local
   `/Users/ogo.ko/.codex/skills/grill-me/SKILL.md` (7 lines). Its `grilling`
   dependency was installed/read from the same source (12 lines). Resolved the
   Phase 9 versus `main` baseline decision with owner confirmation.
2. **premortem** — `parcadei/continuous-claude-v3`,
   `.claude/skills/premortem`; local
   `/Users/ogo.ko/.codex/skills/premortem/SKILL.md` (451 lines). Deep pass,
   verification, owner decision, mitigations, and quick re-check recorded in
   `.logs/vector-envoys/premortem.md`.
3. **caveman** — `JuliusBrussee/caveman`, `skills/caveman`; local
   `/Users/ogo.ko/.codex/skills/caveman/SKILL.md` (77 lines). Simplification
   outcome recorded in the Phase 15 architecture.
4. Design review:
   - **bencium-controlled-ux-designer** — listed Bencium repository/path; local
     skill 738 lines. Required accessibility, responsive, motion, and design
     system references read in full.
   - **game-ui-design** — listed `omer-metin/skills-for-antigravity` path; local
     skill 53 lines. Patterns, sharp-edges, and validation references read.
   - **high-end-visual-design** — listed `leonxlnx/taste-skill`; local
     `/Users/ogo.ko/.agents/skills/high-end-visual-design/SKILL.md` (119 lines).
   - **premium-frontend-ui** — listed `github/awesome-copilot`; local skill 113
     lines.
   - **emil-design-eng** — underlying repository verified as
     `emilkowalski/skill`, `skills/emil-design-eng`; local skill 679 lines. No
     installation URL was invented.
   Synthesis: `.logs/vector-envoys/design-review.md`.
5. **imagegen** — bundled OpenAI system skill, 356 lines. Used for three Wave
   15.0 concept sheets; reusable prompts and output hashes are committed.
6. **hatch-pet** — official OpenAI skill, 923 lines. Full skill plus animation
   rows, contract, and QA rubric references read. Production use remains Wave
   15.5/15.7; no concept is falsely marked hatch-validated.
7. **playwright-interactive** — official OpenAI skill, 693 lines. Full skill
   read. Current tool surface lacks its persistent `js_repl` prerequisite, so
   interactive use remains open; Playwright CLI suites are not misrepresented as
   skill-equivalent evidence.
8. **openai-docs** — bundled OpenAI system skill, 167 lines. Full skill read.
   Current official docs will be consulted immediately before OpenAI worker code
   and live image/vision contract implementation.

## Installation provenance

Absent skills were installed only from sources named by the owner prompt. Source
paths were verified before install. Installer copies do not retain `.git`
metadata, so this log does not invent per-copy commit hashes. Production
`hatch-pet` will use a separate auditable vendoring step with exact upstream
commit, license, file list, SHA-256 manifest, and CI drift verification.
