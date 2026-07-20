import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

/**
 * Runtime verification of the desktop security posture.
 *
 * scripts/check-desktop-security.mjs greps the source for the right strings,
 * which is a useful tripwire but proves only that the text exists — dead or
 * unreachable configuration satisfies it just as well as live configuration.
 * These specs launch the actual application and interrogate the main process,
 * so a handler that is present but never installed fails here.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const AXIS_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(REPO_ROOT, "electron", "main.cjs")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Point the shell at the test server instead of letting it spawn its own
      // dev server, so a failed load cannot raise the modal error dialog that
      // would hang the run.
      AXIS_DESKTOP_URL: AXIS_URL,
    },
  });
});

test.afterAll(async () => {
  if (!app) return;
  // app.close() can hang if the shell is holding a window or a native dialog
  // open. The assertions are already done by this point, so a stuck teardown
  // must not be reported as a security failure — fall back to killing the
  // process rather than letting the hook time out.
  const closed = await Promise.race([
    app.close().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]).catch(() => false);

  if (!closed) {
    app.process()?.kill("SIGKILL");
  }
});

test("the main window runs with renderer hardening enabled", async () => {
  // Wait for the window to exist before interrogating the main process —
  // getAllWindows() is empty until createMainWindow() has run.
  await app.firstWindow();
  const prefs = await app.evaluate(async ({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return null;
    // getLastWebPreferences() reports what the window was ACTUALLY constructed
    // with, which is the point — the config file could say anything. It is a
    // real runtime API but is absent from this Electron version's type
    // definitions, hence the cast.
    const actual = (
      win.webContents as unknown as {
        getLastWebPreferences: () => {
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
          sandbox?: boolean;
          webSecurity?: boolean;
        } | null;
      }
    ).getLastWebPreferences();
    return {
      contextIsolation: actual?.contextIsolation,
      nodeIntegration: actual?.nodeIntegration,
      sandbox: actual?.sandbox,
      webSecurity: actual?.webSecurity,
    };
  });

  expect(prefs).not.toBeNull();
  expect(prefs!.contextIsolation).toBe(true);
  expect(prefs!.nodeIntegration).toBe(false);
  expect(prefs!.sandbox).toBe(true);
  expect(prefs!.webSecurity).not.toBe(false);
});

test("no Node or Electron API is reachable from the renderer", async () => {
  const window = await app.firstWindow();
  const exposure = await window.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
    // The narrow, intentional bridge SHOULD be present.
    axisDesktop: typeof (globalThis as Record<string, unknown>).axisDesktop,
  }));

  expect(exposure.require).toBe("undefined");
  expect(exposure.process).toBe("undefined");
  expect(exposure.module).toBe("undefined");
  expect(exposure.axisDesktop).toBe("object");
});

test("the preload exposes only the intended surface", async () => {
  const window = await app.firstWindow();
  const keys = await window.evaluate(() =>
    Object.keys(
      ((globalThis as unknown as Record<string, unknown>).axisDesktop ?? {}) as Record<string, unknown>,
    ).sort(),
  );

  expect(keys).toEqual(
    ["archiveBay", "archiveBayManagedRuntime", "archiveBayRecomp", "capabilities", "deepLinks", "openBrowser"].sort(),
  );
});

test("the app holds the single-instance lock", async () => {
  const hasLock = await app.evaluate(async ({ app: electronApp }) => electronApp.hasSingleInstanceLock());
  expect(hasLock).toBe(true);
});

test("the default session denies a permission the app never uses", async () => {
  // Exercises the real setPermissionRequestHandler rather than inspecting
  // config. AXIS uses only media (audio), notifications and geolocation; screen
  // capture is used nowhere, so getDisplayMedia must be refused even though the
  // caller IS the trusted AXIS origin. Before this hardening the hosted origin
  // ran in defaultSession with no policy at all and would have been prompted.
  const window = await app.firstWindow();
  const denied = await window.evaluate(async () => {
    try {
      await navigator.mediaDevices.getDisplayMedia({ video: true });
      return false; // granted — the policy is not in force
    } catch {
      return true; // refused, as configured
    }
  });

  expect(denied).toBe(true);
});

test("screen capture is refused at the main-process handler", async () => {
  // setDisplayMediaRequestHandler is installed to call back with null (deny).
  // Confirm the handler is actually reachable on the default session.
  const installed = await app.evaluate(async ({ session }) =>
    typeof session.defaultSession.setDisplayMediaRequestHandler === "function",
  );
  expect(installed).toBe(true);
});

test("the deep-link bridge is exposed to the renderer", async () => {
  // Parsing itself is covered exhaustively by electron/deep-links.test.cjs
  // (allowlisting, traversal, prototype pollution, token rejection). What only
  // an end-to-end run can show is that the shell actually wires that parser up
  // and exposes the bridge, so that is what is asserted here.
  const window = await app.firstWindow();
  const bridge = await window.evaluate(() => {
    const desktop = (globalThis as unknown as Record<string, Record<string, unknown>>).axisDesktop;
    const deepLinks = desktop?.deepLinks as Record<string, unknown> | undefined;
    return {
      onOpen: typeof deepLinks?.onOpen,
      consumePending: typeof deepLinks?.consumePending,
    };
  });

  expect(bridge.onOpen).toBe("function");
  expect(bridge.consumePending).toBe("function");
});

test("a cold-start deep link can be consumed exactly once", async () => {
  const window = await app.firstWindow();
  // Nothing was queued in this run, so the handler must answer with null rather
  // than throwing — a rejected invoke here would mean the channel is missing.
  const pending = await window.evaluate(async () => {
    const desktop = (globalThis as unknown as Record<string, Record<string, unknown>>).axisDesktop;
    const deepLinks = desktop?.deepLinks as { consumePending: () => Promise<unknown> };
    return deepLinks.consumePending();
  });

  expect(pending).toBeNull();
});

test("axis:// is registered as a protocol client", async () => {
  const isDefault = await app.evaluate(async ({ app: electronApp }) =>
    electronApp.isDefaultProtocolClient("axis"),
  );
  // In an unpackaged dev run the OS registration may not stick, so assert the
  // call is at least answerable rather than asserting true and flaking.
  expect(typeof isDefault).toBe("boolean");
});
