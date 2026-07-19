function createUpdateController({
  app,
  autoUpdater,
  dialog,
  getMainWindow,
  observability,
  isQuitting = () => false,
}) {
  if (!app.isPackaged) {
    return {
      checkForUpdates: async () => false,
      dispose() {},
    };
  }

  let manualCheck = false;
  let downloadInProgress = false;
  let updatePromptOpen = false;
  let interval = null;
  let initialTimer = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };

  // These fire from timers, so they can land mid-quit. An ownerless dialog
  // raised then outlives every window and the app never finishes quitting, so
  // a quit in progress wins over any update prompt.
  const showMessage = (options) => {
    if (isQuitting()) return Promise.resolve({ response: -1, canceled: true, checkboxChecked: false });
    const owner = getMainWindow();
    return owner && !owner.isDestroyed()
      ? dialog.showMessageBox(owner, options)
      : dialog.showMessageBox(options);
  };

  const onAvailable = async (info) => {
    manualCheck = false;
    if (updatePromptOpen || downloadInProgress) return;
    updatePromptOpen = true;
    const result = await showMessage({
      type: "info",
      buttons: ["Download update", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "AXIS update available",
      message: `AXIS ${info.version} is available.`,
      detail: "The signed update will download in the background. AXIS will ask before restarting.",
    });
    updatePromptOpen = false;
    if (result.response === 0) {
      downloadInProgress = true;
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        downloadInProgress = false;
        observability.captureException(error, { operation: "update-download" });
        await showMessage({
          type: "error",
          title: "Update failed",
          message: "AXIS could not download the update.",
          detail: "You can continue using this version and try again later.",
        });
      }
    }
  };

  const onNotAvailable = async () => {
    if (!manualCheck) return;
    manualCheck = false;
    await showMessage({
      type: "info",
      title: "AXIS is up to date",
      message: `AXIS ${app.getVersion()} is the latest available version.`,
    });
  };

  const onDownloaded = async (info) => {
    downloadInProgress = false;
    const result = await showMessage({
      type: "info",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "AXIS update ready",
      message: `AXIS ${info.version} is ready to install.`,
      detail: "Restarting closes all AXIS windows. Website sessions remain stored in the isolated browser profile.",
    });
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
  };

  const onError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const releaseChannelEmpty = message.includes("No published versions on GitHub");
    if (releaseChannelEmpty) {
      if (manualCheck) {
        manualCheck = false;
        void showMessage({
          type: "info",
          title: "No desktop release is published yet",
          message: "AXIS could not find a published desktop update channel.",
          detail: "The application will check again automatically after the first signed release is available.",
        });
      }
      return;
    }
    observability.captureException(error, { operation: "update-check" });
    if (!manualCheck) return;
    manualCheck = false;
    void showMessage({
      type: "error",
      title: "Could not check for updates",
      message: "AXIS could not reach the update service.",
      detail: "Check your connection and try again later.",
    });
  };

  autoUpdater.on("update-available", onAvailable);
  autoUpdater.on("update-not-available", onNotAvailable);
  autoUpdater.on("update-downloaded", onDownloaded);
  autoUpdater.on("error", onError);

  const checkForUpdates = async ({ interactive = false } = {}) => {
    manualCheck = interactive;
    try {
      await autoUpdater.checkForUpdates();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };

  initialTimer = setTimeout(() => void checkForUpdates(), 15_000);
  initialTimer.unref?.();
  interval = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  interval.unref?.();

  return {
    checkForUpdates,
    dispose() {
      if (initialTimer) clearTimeout(initialTimer);
      if (interval) clearInterval(interval);
      autoUpdater.removeListener("update-available", onAvailable);
      autoUpdater.removeListener("update-not-available", onNotAvailable);
      autoUpdater.removeListener("update-downloaded", onDownloaded);
      autoUpdater.removeListener("error", onError);
    },
  };
}

module.exports = { createUpdateController };
