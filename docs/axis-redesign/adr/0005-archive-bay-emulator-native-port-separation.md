# ADR 0005 — Archive Bay: emulator/native-port separation, content-rights policy, and child-process threat model

- Status: accepted
- Date: 2026-07-18
- Wave: Phase 16.0 (Archive Bay), owner-authorized parallel desktop track

## Context

The owner authorized a desktop-only "Archive Bay" surface under VECTOR: a
place to launch **user-owned, locally imported** legacy game content via
emulation, alongside any future **native ports/recompilations** Axis ships
directly. This is architecturally and legally a different problem from the
nine `VectorGameSlug` arcade titles (Wave 15.x):

- The 15.x titles are original, Axis-authored, web-bundled, cloud-synced
  games with a Supabase-backed score/save contract.
- Archive Bay content is **not authored by Axis**: it is emulated software
  the *user* already owns, run through a **user-installed** emulator
  (initially melonDS, a Nintendo DS emulator). Axis never distributes,
  hosts, downloads, or scrapes ROMs, BIOS/firmware, or the emulator itself
  in this wave.

Three forces make this its own ADR rather than an extension of the existing
VECTOR platform contracts:

1. **Licensing.** melonDS is GPL-3.0. Distributing (shipping) a GPL-3.0
   binary — even bundled inside an Electron installer — triggers GPL
   source-availability and license-notice obligations for the whole
   distributed work, or at minimum for melonDS itself plus any code linked
   into the same binary. Axis has not made a distribution decision yet.
2. **Content legality.** ROM and BIOS/firmware files are copyrighted works
   Axis has no license to distribute. Any feature that could be read as
   "get games here" (a downloader, a search index, a scraper, a bundled ROM)
   is a legal and reputational risk regardless of technical quality.
3. **Security surface.** This is the first place Axis code spawns an
   arbitrary local executable with a user-supplied file as an argument. That
   is a materially different threat model from anything in the web bundle
   (which never spawns processes) or the existing Electron browser-window
   IPC (`axis-browser:*`, which only ever opens URLs).

## Options considered

1. **Bundle a managed melonDS binary with Axis and auto-launch ROMs.**
   Fastest UX, but: ships a GPL-3.0 binary before a distribution decision is
   made (legal risk), can't be validated in this wave (no signing/build
   pipeline for a third-party binary yet), and conflates "Axis distributes
   melonDS" with "the user brought their own emulator" — two very different
   support and liability postures. Rejected for this wave; deferred to
   16.2+, explicitly gated on this ADR's licensing conclusion.
2. **Bring-your-own-emulator (BYOE): the user installs melonDS themselves
   (from melonDS's own distribution channel); Axis only stores a path to it
   and spawns it with the ROM as an argument.** No Axis-distributed GPL
   binary, no bundled copyrighted content, minimal new attack surface (one
   spawn call, arguments fully controlled by Axis's main process, never by
   the renderer or by melonDS's own CLI surface beyond a single ROM path).
   **Chosen for Wave 16.1.**
3. **Web-based emulation (WASM melonDS in the browser bundle).** Rejected
   outright, independent of licensing: this would bloat the shared web JS
   bundle (already at 98.7% of its CI-enforced budget per Wave 15.3) and
   requires shipping the same GPL-3.0 core to every web visitor, which is a
   *harder* distribution problem than the desktop case, not an easier one.
4. **A native recompilation / from-scratch reimplementation ("native-recomp"
   `LegacyRuntimeKind`).** Not attempted in 16.1 — reserved as a future,
   licensing-clean alternative to emulation for specific titles, modeled now
   only as a domain enum value so the schema doesn't need to change later.

## Decision

**Wave 16.1 ships option 2 only: a bring-your-own-emulator local library and
launcher, desktop-only, with zero network access and zero bundled
content.** Concretely:

- A new domain, `LegacyRuntimeKind = "external-emulator" | "managed-emulator"
  | "native-recomp"`, separate from `VectorGameSlug`. Only
  `"external-emulator"` is implemented in 16.1.
- A new domain record, `LegacyTitleRecord`, keyed by an **opaque
  `contentId`** (a locally generated UUID) plus a **sha256** of the imported
  file. The record never leaves the user's device (no Supabase table, no
  cloud sync, no telemetry) — this is a desktop-local JSON store in
  Electron's `userData` directory, not a redesign-program persistence layer.
- The **actual filesystem path is never sent to the renderer and never
  logged.** The main process resolves `contentId -> path` internally; the
  renderer only ever sees `contentId`, a user-supplied label, the
  `runtimeKind`, and an `addedAt` timestamp.
- Both the ROM path and the emulator executable path are chosen through
  **native OS file-picker dialogs** (`dialog.showOpenDialog`) invoked by the
  main process — never a renderer-supplied string. This means the renderer
  cannot construct or influence either half of the eventual `spawn()` call.
- Launch is `spawn(runtimePath, [romPath], { shell: false })` — a fixed
  two-element argument array with no renderer-suppliable flags, options, or
  additional arguments, ever.
- No feature in this wave downloads, searches for, indexes, scrapes, or
  circumvents protection on ROMs or firmware. UI copy states explicitly:
  *"System files not included. AXIS does not download or provide firmware.
  Import only what you are legally entitled to use."*
- **OWNER LICENSING DECISION (2026-07-18): Option B — distribute a managed
  melonDS runtime in 16.2.** The owner explicitly accepts the GPL-3.0
  redistribution obligations this entails: the packaged runtime must ship with
  the GPL-3.0 license text, a corresponding-source offer (pinned melonDS
  source archive or written offer per GPL §6), and clear attribution; the
  runtime stays a separate spawned executable (arm's-length, never linked
  into AXIS). 16.2 is therefore UNBLOCKED, subject to those compliance
  artifacts shipping with the runtime package. 16.1's BYO path remains
  supported regardless.
- **Supported platforms (16.1):** macOS, Windows, and Linux — the same three
  platforms the existing unsigned Electron preview already targets
  (`docs/desktop-distribution.md`). No platform-specific melonDS discovery
  logic is added in 16.1; the user always selects the executable explicitly.

## Rationale

BYOE is the only option that ships a real, usable feature this wave without
either (a) making an irreversible distribution decision under time pressure,
or (b) blocking on that decision entirely. It also happens to be the
*safer* long-term default even after a licensing decision is made: user
control over which emulator binary runs, sourced from the user's own
trusted install, is a smaller attack surface than Axis re-distributing and
therefore being responsible for the provenance of a third-party binary.

The opaque-`contentId` + main-process-only-path design is chosen specifically
so that:

- A future crash report, log line, or Sentry breadcrumb from anywhere in the
  Electron app cannot leak a user's local filesystem layout (usernames in
  paths, personal folder structures, etc.) or which specific ROMs they own.
- The renderer — which loads a remote HTTPS origin
  (`axis-cko.vercel.app`) inside `contextIsolation: true` / `sandbox: true`,
  same as every other window in this app — never becomes a vector for path
  injection into a `spawn()` call, because it never holds a real path to
  begin with.

Native OS file pickers for *both* the ROM and the runtime executable close
off the two most obvious escalation paths (arbitrary file read via a
crafted ROM path, arbitrary code execution via a crafted "emulator" path)
without needing bespoke path-sanitization logic to get exactly right under
adversarial review — the OS dialog is the trust boundary, not a validated
string.

## Consequences

- **Positive:** A real, useful feature ships with no new legal exposure, no
  bundled copyrighted content, and a small, auditable IPC surface (list /
  import / remove / launch / configure-runtime — five handlers, no free-form
  path or flag parameters accepted from the renderer).
- **Positive:** The design generalizes to any future BYOE emulator (a second
  `external-emulator` target) or to `native-recomp` without a schema change
  — `LegacyRuntimeKind` and `LegacyTitleRecord` do not name melonDS
  specifically anywhere in their types.
- **Negative:** No cloud save/sync, no cross-device library, no
  achievements/leaderboards for imported titles in this wave (by design —
  local-only saves is an explicit hard rule, not a placeholder). A future
  wave that wants any of this must re-open this ADR, since local-only
  storage was chosen partly *because* it avoids sending ROM identity
  (sha256) to any Axis-operated service.
- **Negative:** UX friction — the user must already own melonDS and know
  where its executable lives on disk. This is intentional in 16.1 (BYOE)
  and is the exact scope 16.2+ (managed runtime) would remove, once licensed.
- **Security:** every new IPC handler runs in the main process behind
  `contextIsolation`/`sandbox`, matches the existing `axis-browser:*` pattern,
  and is unit-tested (`electron/archive-bay.test.cjs`) for path
  canonicalization, extension validation, and exact spawn-argument shape.
  `scripts/check-desktop-security.mjs`'s existing invariants
  (`contextIsolation: true`, `sandbox: true`, etc.) already cover the whole
  `electron/` and `src/` tree, so no new security-check script is required
  for this wave — the invariants it already enforces apply here too.

## Reversal cost

Low. Nothing in 16.1 touches the web bundle, the Supabase schema, or the
VECTOR arcade platform's contracts. The entire feature lives in `electron/`
(new module + IPC handlers) plus one new, additively-routed Next.js page
gated on `window.axisDesktop?.archiveBay` existing. Removing it means
deleting that page/component and the IPC handlers; no data migration, no
RLS review, no coordination with any other wave.
