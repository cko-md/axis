"use client";

import { useCallback, useEffect, useState } from "react";
import { AxisChromePanel } from "@/components/ui/axis/AxisChromePanel";
import { Button } from "@/components/ui/Button";
import { StatusCallout } from "@/components/ui/StatusCallout";
import {
  getArchiveBayBridge,
  type ArchiveBayLaunchState,
  type ArchiveBayLibrary,
} from "@/lib/archive-bay";
import styles from "./Vector.module.css";

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
