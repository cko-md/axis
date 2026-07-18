# Axis Desktop (Electron) — build & distribution

Axis ships an optional **Electron desktop app** that wraps the deployed web app
(`https://axis-cko.vercel.app`). It targets **macOS, Windows, and Linux** — it is
**not** an iOS app, so none of the iOS/Xcode concepts apply (no device
provisioning profiles, no Developer Mode on a device, no 7‑day profile expiry,
no weekly rebuilds).

There are two paths, gated by whether the artifacts are **code‑signed**.

| | Unsigned preview | Signed release |
|---|---|---|
| Purpose | Personal use / iterating | Distributable installers |
| Cost | Free | Apple Dev Program ($99/yr) + Azure Trusted Signing |
| Secrets | None | Apple + Azure (below) |
| CI workflow | `.github/workflows/desktop-preview.yml` | `desktop-release.yml` (deferred — not in the repo yet) |
| Trigger tag | `desktop-preview-v*` | `desktop-v*` |
| Gatekeeper/SmartScreen | Warns; user bypasses manually | Clean install, no warnings |

---

## 1. Unsigned preview (current, no secrets)

This is what's landed. Nothing to configure.

**Build & run locally (macOS):**
```bash
npm ci && npm ci --prefix electron
npm run desktop:dist -- --mac        # → dist-electron/AXIS-*.dmg (+ .app)
```
Open the `.app` once via **right‑click → Open** (then "Open" in the dialog), or
clear the quarantine attribute:
```bash
xattr -dr com.apple.quarantine "/path/to/AXIS.app"
```
After that first launch it runs indefinitely. Windows: `npm run desktop:dist -- --win`;
the unsigned `.exe` triggers a SmartScreen "More info → Run anyway" once.

**Useful scripts:** `desktop:dev` (run from source), `desktop:start`, `desktop:test`
(runs `electron/*.test.cjs`), `desktop:check` (version + security + tests),
`desktop:size` / `desktop:size:check` (installer size budget),
`desktop:preview:validate`.

**CI:** push a tag `desktop-preview-v0.1.0` → the *Unsigned Desktop Preview*
workflow builds unsigned macOS + Windows artifacts and asserts they are unsigned.
It does **not** run on normal pushes/PRs.

---

## 2. Signed release (paid — deferred until secrets exist)

Signing is what lets other people install without OS warnings. It requires paid
accounts and the `desktop-release.yml` workflow (intentionally **not** re‑landed
yet — re‑add it from the `codex/electron-preview-release` branch when ready). The
release helper scripts *are* in the repo already.

Release is triggered by pushing a `desktop-v*` tag; electron‑builder runs with
`--publish never` and the workflow builds **mac** (Developer ID + notarized),
**windows** (Azure Trusted Signing), and **linux** (unsigned).

### 2a. macOS — Apple Developer ID + notarization

Prereq: **Apple Developer Program** membership ($99/yr).

1. **Developer ID Application certificate** — create in the Apple Developer portal
   (Certificates → *Developer ID Application*), or via Xcode (Settings → Accounts →
   Manage Certificates → +). Export it as a password‑protected `.p12`.
2. **Base64‑encode** the `.p12`: `base64 -i DeveloperID.p12 | pbcopy`.
3. **App Store Connect API key** (for notarization) — App Store Connect → Users
   and Access → Integrations → App Store Connect API → generate a key. Note the
   **Key ID** and **Issuer ID**; download the `.p8` (once).

GitHub → Settings → Secrets and variables → Actions → *New repository secret*:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | base64 of the Developer ID `.p12` |
| `MAC_CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY_ID` | App Store Connect API **Key ID** |
| `APPLE_API_ISSUER` | App Store Connect API **Issuer ID** |
| `APPLE_API_KEY_CONTENT` | full text of the `.p8` file |

The workflow writes `APPLE_API_KEY_CONTENT` to a temp `AuthKey.p8`, then
electron‑builder signs with the Developer ID cert and notarizes via the API key.
It verifies with `codesign --verify --deep --strict` and staples the ticket.

### 2b. Windows — Azure Trusted Signing

Prereq: an **Azure Trusted Signing** account + certificate profile, and an Entra
app registration (service principal) with access to it.

**Secrets:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
**Repo variables** (Settings → *Variables*, not secrets): `AZURE_TRUSTED_SIGNING_ENDPOINT`,
`AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERT_PROFILE`,
`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

### 2c. Optional

`AXIS_DESKTOP_SENTRY_DSN` (falls back to `NEXT_PUBLIC_SENTRY_DSN`) — desktop crash
reporting. Optional for both preview and release.

### Adding secrets

```bash
gh secret set MAC_CSC_LINK < DeveloperID.p12.b64
gh secret set MAC_CSC_KEY_PASSWORD
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER
gh secret set APPLE_API_KEY_CONTENT < AuthKey.p8
# windows
gh secret set AZURE_TENANT_ID
gh secret set AZURE_CLIENT_ID
gh secret set AZURE_CLIENT_SECRET
gh variable set AZURE_TRUSTED_SIGNING_ENDPOINT --body "https://…"
# …etc
```
Helper checks (once secrets are set): `npm run desktop:secrets:check`,
`npm run desktop:apple-signing:check`, `npm run desktop:windows-signing:check`.
Interactive setup helpers: `desktop:apple-signing:configure`,
`desktop:windows-signing:configure`.

### Cutting a signed release

1. Add signing secrets/variables above.
2. Re‑land `desktop-release.yml` from `codex/electron-preview-release`.
3. `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0` → the release
   workflow builds/signs/notarizes and uploads artifacts.

---

## Notes

- The web app never imports `electron/`; the desktop package is fully separate and
  does not affect `next build`.
- `electron/node_modules/` and `dist-electron/` are git‑ignored (build artifacts).
- Provenance / no‑autonomous‑execution rules still apply — the desktop app is just
  a shell over the same authenticated web app.
