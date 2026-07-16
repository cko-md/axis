# AXIS Desktop

AXIS Desktop is an Electron shell around the existing Next.js application. It
preserves the deployed server/API architecture while upgrading `useWebViewer()`
links to isolated Chromium `WebContentsView` browser windows. The hosted app
continues to use the sandboxed preview and Mozilla Readability fallback.

## Development

Prerequisites:

- Node.js 24
- A current Electron-supported desktop OS

Run:

```bash
npm run desktop:dev
```

Electron starts AXIS at `http://127.0.0.1:3000` and loads that origin in the
trusted main window.

## Production origin

Packaged releases are pinned to `https://axis-cko.vercel.app`. That origin is
written into signed package metadata at build time and cannot be replaced with
an ambient `AXIS_DESKTOP_URL` environment variable after installation. Source
builds can still use `AXIS_DESKTOP_URL` for development.

IPC requests are accepted only from the configured AXIS origin. Third-party
pages run in sandboxed `WebContentsView` instances with no preload, Node
integration, or AXIS IPC bridge.

The trusted preload includes a narrow rolling-deploy compatibility bridge. If
the hosted AXIS origin is still serving the previous WebViewer implementation,
it detects that modal, hands its URL to the isolated Chromium window, and closes
the legacy iframe. It also preserves the two-state sidebar preference until the
hosted sidebar update reaches production. The bridge disables itself when it
detects the new hosted controls, so desktop releases do not depend on a
simultaneous web deployment.

## Reader behavior

- Desktop: links open in isolated Chromium browser windows with address,
  back/forward, reload/stop, open-external, and Reader controls.
- Web: links use the in-app sandboxed preview.
- Web fallback: `/api/reader/extract` uses Mozilla Readability plus DOMPurify.
- OAuth/login pages continue to open in the system browser.

## Release and auto-update delivery

Desktop releases use public GitHub Releases in `cko-md/axis`. A tag matching the
desktop package version starts `.github/workflows/desktop-release.yml`:

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The workflow builds macOS x64/ARM64, Windows x64, and Linux x64 artifacts. It
publishes the installers, blockmaps, and `latest*.yml` metadata consumed by
`electron-updater`. Installed applications check 15 seconds after startup and
every six hours. Downloads require user confirmation, and installation requires
an explicit restart confirmation. A native “Check for Updates…” menu item is
also available.

### Unsigned evaluation wave

Until Apple and Microsoft signing identities are available, a separate
prerelease channel can publish evaluation installers:

```bash
git tag desktop-preview-v0.1.0
git push origin desktop-preview-v0.1.0
```

`.github/workflows/desktop-preview.yml` deliberately disables certificate
discovery, proves the macOS and Windows applications are unsigned, marks the
GitHub Release as an unsigned prerelease, and publishes checksums. It does **not** publish
`latest*.yml` or blockmap files, so it cannot enter or contaminate the signed
`desktop-v*` auto-update channel. Gatekeeper and SmartScreen warnings are
expected. This is an evaluation build, not a final signed release.

### Deferred signed production wave

The `desktop-v*` workflow remains the production channel. It will not publish
until Developer ID signing, Apple notarization, stapling, Gatekeeper
verification, Azure Artifact Signing, and Windows Authenticode verification all
pass. Owner-controlled Apple and Azure identity values are prerequisites.

Required GitHub Actions secrets:

| Secret | Purpose |
|---|---|
| `AXIS_DESKTOP_SENTRY_DSN` | Public Sentry DSN embedded for native crash and safe desktop error ingestion. `NEXT_PUBLIC_SENTRY_DSN` is accepted as a fallback. |
| `MAC_CSC_LINK` | Base64 or URL/path form of a Developer ID Application `.p12`. |
| `MAC_CSC_KEY_PASSWORD` | Password for the signing certificate. |
| `APPLE_API_KEY_CONTENT` | Raw App Store Connect API `.p8` key content. |
| `APPLE_API_KEY_ID` | App Store Connect API key ID. |
| `APPLE_API_ISSUER` | App Store Connect issuer ID. |
| `AZURE_TENANT_ID` | Microsoft Entra tenant containing the signing service principal. |
| `AZURE_CLIENT_ID` | Application/client ID for the signing service principal. |
| `AZURE_CLIENT_SECRET` | Service-principal secret used only by the Windows release job. |

Required GitHub Actions variables:

| Variable | Purpose |
|---|---|
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Regional Azure Artifact Signing endpoint. |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Artifact Signing account name. |
| `AZURE_TRUSTED_SIGNING_CERT_PROFILE` | Public-trust certificate profile. |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | Certificate common name, matched during build and verification. |

Once Apple has issued the Developer ID Application certificate and App Store
Connect API key, install them without putting their values on the command line
or in repository files:

```bash
npm run desktop:secrets:configure -- \
  --certificate /path/to/DeveloperIDApplication.p12 \
  --api-key /path/to/AuthKey.p8 \
  --key-id ABC123DEFG \
  --issuer 00000000-0000-0000-0000-000000000000
```

The command prompts for the `.p12` password with terminal echo disabled,
validates the certificate, stores the five Apple values directly through the
GitHub CLI, and prints secret names/status only. Confirm readiness with
`npm run desktop:apple-signing:check`. Use
`npm run desktop:secrets:check` to verify both production signing platforms.

For Windows, create an Azure Artifact Signing account, public-trust certificate
profile, and an Entra application with the Certificate Profile Signer role.
Then store the values without printing the client secret:

```bash
npm run desktop:windows-signing:configure -- \
  --tenant-id 00000000-0000-0000-0000-000000000000 \
  --client-id 00000000-0000-0000-0000-000000000000 \
  --endpoint https://eus.codesigning.azure.net/ \
  --account axis-signing \
  --profile public-trust \
  --publisher "AXIS"
```

The command prompts for `AZURE_CLIENT_SECRET` with terminal echo disabled.
Confirm the Windows configuration with
`npm run desktop:windows-signing:check`.

Release packaging sets `forceCodeSigning` on macOS and Windows. The workflow
verifies the Developer ID signature, stapled notarization ticket, Gatekeeper
assessment, Authenticode status, and expected Windows publisher before
publishing. Missing or invalid credentials fail the release instead of emitting
an unsigned production artifact.

## Browser compatibility controls

### Managed unpacked extensions

AXIS supports explicitly enabled unpacked extensions through Electron's
persistent `axis-browser` session. Open the ◫ Browser capabilities control,
choose **Open extension folder**, place an unpacked extension in one child
directory, and list that directory in `enabled.json`. Reload from the same
dialog.

This is not Chrome Web Store compatibility. Electron supports only a subset of
extension APIs. AXIS rejects symlinks and extensions requesting `debugger`,
`nativeMessaging`, `proxy`, or `vpnProvider`. It also reports how many enabled
extensions request access to all sites. Toolbar-dependent password-manager
extensions and packed `.crx` installers remain unsupported.

### Proprietary DRM

The stock Electron distribution does not bundle Widevine. AXIS identifies
common DRM streaming hosts and displays an explicit system-browser handoff
instead of allowing playback to fail without explanation. Full in-app Widevine
would require a separately reviewed castLabs Electron for Content Security
build, vendor onboarding, and VMP package signing. That is a distinct
supply-chain and licensing wave, not a flag that can safely be enabled in the
stock binary.

### Password managers

AXIS detects the presence of password fields only as a boolean; it never reads
their values. It does not capture, store, sync, or autofill site credentials.
When a login form is detected, the browser explains that Chrome/Edge Sync and
installed password-manager integration require the ↗ system-browser path. This
avoids creating an unaudited AXIS credential vault while retaining ordinary
site cookies in the isolated browser profile.

## Crash reporting

Electron Crashpad starts before any renderer is created. Release builds upload
native main, renderer, utility, and GPU-process minidumps to the Sentry minidump
endpoint derived from the public DSN. Controlled desktop failures and unhandled
JavaScript errors use a minimal Sentry envelope sender. It strips URLs, local
user paths, nested metadata, and all user content before submission. Development
builds without a DSN retain local Crashpad collection but do not upload.

The native upload path can be verified against an isolated blank renderer in a
telemetry-enabled package:

```bash
AXIS_DESKTOP_CRASH_SMOKE=renderer \
  dist-electron/mac-arm64/AXIS.app/Contents/MacOS/AXIS
```

The smoke switch is inert unless explicitly set and fails if the package has no
embedded desktop Sentry DSN. It does not crash the trusted AXIS renderer or load
user content.

## Electron tradeoffs

Electron adds a materially larger download because Chromium ships with the
application. AXIS keeps the shell small by loading the existing deployed Next.js
application instead of bundling a duplicate server or frontend build. Packaging
keeps only the English locale, uses maximum ASAR compression, includes a narrow
file allowlist, and builds per-architecture artifacts instead of one larger
universal macOS binary. The release gate caps each unpacked app at 250 MiB, the
application ASAR at 5 MiB, and each installer/archive at 120 MiB.

Electron/Chromium must remain current. For every desktop release:

1. Run `npm run desktop:check`.
2. Run `npm run desktop:check:current`.
3. Run `npm audit` and `npm audit --prefix electron`.
4. Record packaged application size with `npm run desktop:size`.
5. Update Electron immediately when the daily current-stable check opens a
   health issue.

Browser views are created lazily and destroyed with their parent window. They
share one persistent `axis-browser` session to avoid redundant partitions and
retain ordinary site cookies while keeping all Electron/Node APIs unavailable.
The session removes Electron’s product token from its user agent to reduce
unnecessary site rejection.

This is Chromium, not Google Chrome. AXIS now supports controlled unpacked
extensions and gives explicit handoffs for proprietary DRM and external password
managers, but it does not claim Chrome Web Store, Chrome Sync, or Widevine
parity. Sites can also deliberately reject custom Chromium clients. Navigation
failures show a compatibility message, and the always-available ↗ action moves
the current HTTPS page to the system browser. The removed legacy
`ExternalWindow` iframe must not be restored; `npm run desktop:check` fails if
the unsafe `allow-scripts` plus `allow-same-origin` sandbox combination returns.
