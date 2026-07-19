"use client";

import { useCallback, useEffect, useState } from "react";
import { AxisChromePanel } from "@/components/ui/axis/AxisChromePanel";
import { Button } from "@/components/ui/Button";
import { StatusCallout } from "@/components/ui/StatusCallout";
import {
  getArchiveBayBridge,
  getArchiveBayManagedRuntimeBridge,
  type ArchiveBayLaunchState,
  type ArchiveBayLibrary,
  type ManagedRuntimeManifestInfo,
  type ManagedRuntimeProgress,
  type ManagedRuntimeStatus,
} from "@/lib/archive-bay";
import styles from "./Vector.module.css";

function codeFromUnknownError(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)
    ? error.message
    : "RUNTIME_UNKNOWN_ERROR";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * Phase 16.2 — managed melonDS runtime section. Desktop-only, lives inside
 * the same lazy-loaded Archive Bay chunk (no new route-level bundle
 * impact). Honest states only: not-installed / downloading(progress) /
 * verifying / extracting / installed / error / removing. License and
 * source-availability copy is shown BEFORE the install action, per
 * ADR-0005's Option B compliance requirements — this never auto-downloads
 * anything; every transition here is the direct result of a button click.
 */
function ManagedRuntimeSection() {
  const bridge = getArchiveBayManagedRuntimeBridge();
  const [manifest, setManifest] = useState<ManagedRuntimeManifestInfo | null>(null);
  const [status, setStatus] = useState<ManagedRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<ManagedRuntimeProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const [manifestInfo, statusInfo] = await Promise.all([bridge.getManifest(), bridge.getStatus()]);
      setManifest(manifestInfo);
      setStatus(statusInfo);
    } catch (error) {
      setErrorCode(codeFromUnknownError(error));
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    if (!bridge) return;
    return bridge.onProgress((next) => {
      setProgress(next);
      if (next.phase === "error") setErrorCode(next.code);
      if (next.phase === "installed" || next.phase === "not-installed") {
        setErrorCode(null);
        void refresh();
      }
    });
  }, [refresh, bridge]);

  if (!bridge || !manifest) return null;

  const install = async () => {
    setBusy(true);
    setErrorCode(null);
    try {
      await bridge.install();
      await refresh();
    } catch (error) {
      setErrorCode(codeFromUnknownError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setErrorCode(null);
    try {
      await bridge.remove();
      await refresh();
    } catch (error) {
      setErrorCode(codeFromUnknownError(error));
    } finally {
      setBusy(false);
    }
  };

  const installing = busy || Boolean(status?.installing)
    || progress?.phase === "downloading" || progress?.phase === "verifying" || progress?.phase === "extracting";

  return (
    <AxisChromePanel className={styles.gameUtilityBar} data-testid="archive-bay-managed-runtime">
      <div>
        <strong>Managed melonDS runtime (optional)</strong>
        <p style={{ margin: "4px 0 0", fontSize: 12 }}>
          {manifest.runtime} {manifest.version} · License {manifest.license} (
          <a href={manifest.licenseUrl} target="_blank" rel="noreferrer">full text</a>
          ) · Corresponding source available at{" "}
          <a href={manifest.sourceUrl} target="_blank" rel="noreferrer">{manifest.sourceUrl}</a>.
          {" "}{manifest.attribution}
        </p>
      </div>

      {!manifest.platformSupported ? (
        <StatusCallout kind="empty" title="No managed build for this platform yet.">
          Use &ldquo;Choose your installed melonDS&rdquo; above instead — the bring-your-own-emulator
          path works on every platform this app supports.
        </StatusCallout>
      ) : (
        <>
          <span data-testid="archive-bay-managed-runtime-status">
            {status?.installed
              ? `Installed: melonDS ${status.installed.version} (added ${new Date(status.installed.installedAt).toLocaleDateString()})`
              : `Not installed — download is ${formatBytes(manifest.sizeBytes)}, fetched only when you choose to install.`}
          </span>

          {progress?.phase === "downloading" ? (
            <StatusCallout kind="loading" title="Downloading melonDS.">
              {progress.totalBytes
                ? `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`
                : formatBytes(progress.receivedBytes)}
            </StatusCallout>
          ) : null}
          {progress?.phase === "verifying" ? (
            <StatusCallout kind="loading" title="Verifying download integrity (sha256).">
              Activation is refused unless the downloaded bytes match the pinned checksum exactly.
            </StatusCallout>
          ) : null}
          {progress?.phase === "extracting" ? (
            <StatusCallout kind="loading" title="Installing melonDS.">
              Extracting the verified archive.
            </StatusCallout>
          ) : null}
          {progress?.phase === "removing" ? (
            <StatusCallout kind="loading" title="Removing melonDS.">
              Deleting the installed runtime files.
            </StatusCallout>
          ) : null}
          {errorCode ? (
            <StatusCallout kind="error" title="Managed runtime action failed.">
              <code>{errorCode}</code>
            </StatusCallout>
          ) : null}

          <Button
            variant="primary"
            disabled={installing}
            onClick={() => void install()}
            data-testid="archive-bay-managed-runtime-install"
          >
            {status?.installed ? "Reinstall / repair…" : "Install managed melonDS…"}
          </Button>
          {status?.installed ? (
            <Button
              variant="danger"
              disabled={installing}
              onClick={() => void remove()}
              data-testid="archive-bay-managed-runtime-remove"
            >
              Remove managed runtime
            </Button>
          ) : null}
        </>
      )}
    </AxisChromePanel>
  );
}

type ViewState =
  | { status: "detecting" }
  | { status: "not-desktop" }
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; library: ArchiveBayLibrary };

/**
 * Archive Bay (Phase 16.1) — desktop-only, bring-your-own-emulator local
 * library under VECTOR. Bridge calls exist only inside the Electron app;
 * in a normal browser this renders an honest desktop-only notice. No ROM,
 * BIOS, firmware, or emulator is ever bundled, downloaded, or provided.
 */
export function ArchiveBayModule() {
  const [view, setView] = useState<ViewState>({ status: "detecting" });
  const [launchState, setLaunchState] = useState<ArchiveBayLaunchState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = getArchiveBayBridge();
    if (!bridge) {
      setView({ status: "not-desktop" });
      return;
    }
    setView((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const library = await bridge.list();
      setView({ status: "ready", library });
    } catch (error) {
      setView({
        status: "error",
        code: error instanceof Error && /^ARCHIVE_BAY_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "ARCHIVE_BAY_UNKNOWN_ERROR",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const bridge = getArchiveBayBridge();
    if (!bridge) return;
    return bridge.onLaunchState((state) => {
      setLaunchState(state);
      void refresh();
    });
  }, [refresh]);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (error) {
      setView({
        status: "error",
        code: error instanceof Error && /^ARCHIVE_BAY_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "ARCHIVE_BAY_UNKNOWN_ERROR",
      });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const bridge = getArchiveBayBridge();

  return (
    <div className={styles.gameShell} data-testid="archive-bay">
      <section className={styles.gameHero}>
        <div className={styles.gameHeroCopy}>
          <div className={styles.eyebrow}>VECTOR / Archive Bay</div>
          <h1>Archive Bay</h1>
          <p className={styles.gameSubtitle}>
            Launch legacy titles you already own, through an emulator you already installed.
          </p>
          <StatusCallout kind="info" title="System files are not included.">
            AXIS does not download, bundle, or provide ROMs, BIOS, or firmware, and it does not
            include or distribute an emulator. Import only content you are legally entitled to
            use, and point Archive Bay at the melonDS you installed yourself. Saves stay on this
            device; nothing about your library is synced or reported anywhere.
          </StatusCallout>
        </div>
      </section>

      {view.status === "detecting" || view.status === "loading" ? (
        <StatusCallout kind="loading" title="Checking this device.">
          Archive Bay is reading its local, device-only library.
        </StatusCallout>
      ) : null}

      {view.status === "not-desktop" ? (
        <div data-testid="archive-bay-not-desktop">
          <StatusCallout kind="empty" title="Archive Bay is desktop-only.">
            Emulation launches a local process on your machine, so this surface works only inside
            the AXIS desktop app. Nothing here is available from the web browser.
          </StatusCallout>
        </div>
      ) : null}

      {view.status === "error" ? (
        <StatusCallout kind="error" title="Archive Bay could not continue.">
          <code>{view.code}</code> — the failure is local to this device; no library detail was
          reported anywhere.
        </StatusCallout>
      ) : null}

      {view.status === "ready" ? (
        <>
          <AxisChromePanel className={styles.gameUtilityBar}>
            <span data-testid="archive-bay-runtime-status">
              {view.library.runtimeConfigured
                ? "Emulator configured (user-installed melonDS)"
                : "No emulator configured yet"}
            </span>
            <Button
              disabled={busy}
              onClick={() => run(() => bridge!.chooseRuntime())}
              data-testid="archive-bay-choose-runtime"
            >
              {view.library.runtimeConfigured ? "Change emulator…" : "Choose your installed melonDS…"}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => run(() => bridge!.import())}
              data-testid="archive-bay-import"
            >
              Import a .nds you own…
            </Button>
          </AxisChromePanel>

          <ManagedRuntimeSection />

          {launchState ? (
            <StatusCallout
              kind={launchState.status === "error" ? "error" : "info"}
              title={
                launchState.status === "running"
                  ? "Emulator running."
                  : launchState.status === "exited"
                    ? `Emulator exited${launchState.exitCode === null ? "" : ` (code ${launchState.exitCode})`}.`
                    : "The emulator could not launch."
              }
            >
              {launchState.status === "error"
                ? "Check that the configured executable is your working melonDS install, then choose it again."
                : "The game runs in melonDS's own window; its saves live in melonDS's own save directory."}
            </StatusCallout>
          ) : null}

          {view.library.titles.length === 0 ? (
            <StatusCallout kind="empty" title="No imported titles yet.">
              Import a .nds file you own to add it to this device-only library.
            </StatusCallout>
          ) : (
            <div className={styles.saveSlotList} data-testid="archive-bay-titles">
              {view.library.titles.map((title) => (
                <article key={title.contentId}>
                  <div>
                    <strong>{title.label}</strong>
                    <span>
                      {title.runtimeKind === "external-emulator"
                        ? "Your installed emulator"
                        : title.runtimeKind}
                      {" · added "}
                      {new Date(title.addedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    disabled={
                      busy
                      || !view.library.runtimeConfigured
                      || view.library.activeLaunch !== null
                    }
                    onClick={() => run(() => bridge!.launch(title.contentId))}
                  >
                    {view.library.activeLaunch?.contentId === title.contentId ? "Running…" : "Launch"}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy || view.library.activeLaunch?.contentId === title.contentId}
                    onClick={() => run(() => bridge!.remove(title.contentId))}
                  >
                    Remove from library
                  </Button>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
