/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

const openBrowser = (input) => ipcRenderer.invoke("axis-browser:open", input);

// Phase 16.1 Archive Bay (desktop-only). Every method is a thin invoke/on
// wrapper — no filesystem path or flag ever originates in this renderer-side
// code; the main process resolves paths via native file dialogs and an
// opaque contentId (see electron/archive-bay.cjs and main.cjs).
const archiveBay = {
  list: () => ipcRenderer.invoke("archive-bay:list"),
  import: (input) => ipcRenderer.invoke("archive-bay:import", input),
  remove: (contentId) => ipcRenderer.invoke("archive-bay:remove", contentId),
  launch: (contentId) => ipcRenderer.invoke("archive-bay:launch", contentId),
  getRuntimeStatus: () => ipcRenderer.invoke("archive-bay:runtime-status"),
  chooseRuntime: () => ipcRenderer.invoke("archive-bay:runtime-choose"),
  onLaunchState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("archive-bay:launch-state", handler);
    return () => ipcRenderer.removeListener("archive-bay:launch-state", handler);
  },
};

// Phase 16.2 managed melonDS runtime (desktop-only). Same thin invoke/on
// shape as archiveBay above — this renderer-side code never sees a
// download URL, a digest, or a filesystem path; it only ever sees version
// numbers, byte counts, license/attribution text, and install-progress
// phase strings. The manifest that supplies those values lives in the main
// process (electron/config/archive-bay-runtimes.json) and is never
// renderer-suppliable.
const archiveBayManagedRuntime = {
  getManifest: () => ipcRenderer.invoke("archive-bay:managed-runtime:manifest"),
  getStatus: () => ipcRenderer.invoke("archive-bay:managed-runtime:status"),
  install: () => ipcRenderer.invoke("archive-bay:managed-runtime:install"),
  remove: () => ipcRenderer.invoke("archive-bay:managed-runtime:remove"),
  onProgress(listener) {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on("archive-bay:managed-runtime:progress", handler);
    return () => ipcRenderer.removeListener("archive-bay:managed-runtime:progress", handler);
  },
};

contextBridge.exposeInMainWorld("axisDesktop", {
  openBrowser,
  archiveBay,
  archiveBayManagedRuntime,
});

const SIDEBAR_PREF_KEY = "axis-sidebar";
const COMPAT_STYLE_ID = "axis-desktop-host-compat";

function safeHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function parseLegacyViewerUrl() {
  const iframe = document.querySelector("iframe.wv-frame");
  const iframeSrc = iframe?.getAttribute("src") || "";
  if (iframeSrc) {
    try {
      const proxyUrl = new URL(iframeSrc, window.location.origin);
      const target = proxyUrl.pathname === "/api/proxy" ? proxyUrl.searchParams.get("url") : null;
      if (target) return safeHttpUrl(target);
    } catch {
      // Fall through to the address-bar value.
    }
  }

  const raw = document.querySelector(".wv-urlbar input")?.value?.trim();
  if (!raw) return null;
  return safeHttpUrl(raw);
}

function installCompatibilityStyle() {
  if (document.getElementById(COMPAT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = COMPAT_STYLE_ID;
  style.textContent = `
    .app-shell {
      transition: grid-template-columns 320ms cubic-bezier(.16,1,.3,1) !important;
    }
    .sidebar {
      width: var(--sb-w);
      min-width: 0;
      transition: width 320ms cubic-bezier(.16,1,.3,1), transform 320ms cubic-bezier(.16,1,.3,1) !important;
    }
    .sb-toggle {
      width: 27px !important;
      height: 27px !important;
      border-radius: 999px !important;
      transition: left 320ms cubic-bezier(.16,1,.3,1), color .16s, border-color .16s, transform .16s !important;
    }
    .sb-toggle:hover { transform: translate(-50%,-50%) scale(1.06) !important; }
    .sb-toggle:active { transform: translate(-50%,-50%) scale(.96) !important; }
  `;
  document.head.append(style);
}

function installLegacySidebarBridge() {
  let syntheticClick = false;
  let preferenceApplied = false;

  const mode = () => {
    const shell = document.querySelector(".app-shell");
    if (shell?.classList.contains("mode-open")) return "open";
    if (shell?.classList.contains("mode-icons")) return "icons";
    if (shell?.classList.contains("mode-hidden")) return "hidden";
    return null;
  };

  const clickToggle = (toggle) => {
    syntheticClick = true;
    toggle.click();
    syntheticClick = false;
  };

  const sync = () => {
    const currentMode = mode();
    const toggle = document.querySelector(".sb-toggle");
    if (!currentMode || !toggle) return;

    // The updated hosted shell owns its own persistence and two-state control.
    if (toggle.hasAttribute("aria-expanded")) return;

    if (!preferenceApplied && window.innerWidth >= 860) {
      preferenceApplied = true;
      try {
        if (window.localStorage.getItem(SIDEBAR_PREF_KEY) === "icons" && currentMode === "open") {
          clickToggle(toggle);
          return;
        }
      } catch {
        // Keep the hosted default when storage is unavailable.
      }
    }

    if (currentMode === "open" || currentMode === "icons") {
      try {
        window.localStorage.setItem(SIDEBAR_PREF_KEY, currentMode);
      } catch {
        // Device preferences are best-effort.
      }
    }
  };

  document.addEventListener("click", (event) => {
    const toggle = event.target?.closest?.(".sb-toggle");
    if (!toggle || syntheticClick || toggle.hasAttribute("aria-expanded")) return;
    if (mode() !== "icons") return;

    // Legacy hosted code cycles icons → hidden. Desktop keeps the smoother
    // two-state open ↔ icons interaction until the hosted update is deployed.
    event.preventDefault();
    event.stopImmediatePropagation();
    clickToggle(toggle);
    window.requestAnimationFrame(() => clickToggle(toggle));
  }, true);

  return sync;
}

function installLegacyViewerBridge() {
  let handoffInProgress = false;

  return () => {
    const overlay = document.querySelector(".wv-overlay");
    if (!overlay || overlay.dataset.axisDesktopHandoff === "1" || handoffInProgress) return;
    const url = parseLegacyViewerUrl();
    if (!url) return;

    overlay.dataset.axisDesktopHandoff = "1";
    handoffInProgress = true;
    const title = document.querySelector(".wv-tab-active")?.getAttribute("title")
      || document.querySelector(".wv-tab-active .wv-tab-title")?.textContent?.trim()
      || undefined;

    void openBrowser({ url, title }).finally(() => {
      handoffInProgress = false;
    });
    document.querySelector(".wv-close")?.click();
  };
}

window.addEventListener("DOMContentLoaded", () => {
  installCompatibilityStyle();
  const syncSidebar = installLegacySidebarBridge();
  const syncViewer = installLegacyViewerBridge();
  const sync = () => {
    syncSidebar();
    syncViewer();
  };
  sync();
  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
  });
});
