import { expect, test, type Page } from "@playwright/test";

const GAME_SLUGS = [
  "second-sense",
  "brickrise",
  "time-to-fly",
  "paper-glider",
  "envoy-arena",
  "phantasy-axis",
  "biome-lab",
  "mini-town",
  "neon-rift",
] as const;

function observeBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  return failures;
}

async function installBiometricPromptAutoDismiss(page: Page) {
  const prompt = page.getByRole(
    "dialog",
    { name: "Use Face ID / Touch ID for faster sign-in?" },
  );
  await page.addLocatorHandler(prompt, async () => {
    await prompt.getByRole("button", { name: "Not now" }).click();
  });
}

async function expectVectorReady(page: Page) {
  await expect(page.getByTestId("vector-data-state")).toHaveAttribute(
    "data-state",
    "ready",
    { timeout: 45_000 },
  );
}

test("VECTOR lobby persists real local settings and exposes truthful platform utilities", async ({ page }) => {
  test.setTimeout(240_000);
  const failures = observeBrowserFailures(page);
  const loginPrefetches: string[] = [];
  page.on("request", (request) => {
    const headers = request.headers();
    if (
      new URL(request.url()).pathname === "/login"
      && headers["next-router-prefetch"] === "1"
    ) {
      loginPrefetches.push(request.url());
    }
  });
  await installBiometricPromptAutoDismiss(page);
  await page.goto("/vector");

  const lobby = page.getByTestId("vector-lobby");
  await expect(lobby).toBeVisible();
  await expectVectorReady(page);
  for (const slug of GAME_SLUGS) {
    await expect(page.getByTestId(`vector-game-card-${slug}`)).toHaveAttribute(
      "data-game-status",
      // Second Sense shipped in Wave 15.3 as the first available title;
      // every other catalog entry remains honestly planned.
      slug === "second-sense" ? "available" : "planned",
    );
  }

  await page.getByTestId("vector-motion").selectOption("reduced");
  await expect(lobby).toHaveAttribute("data-motion", "reduced");
  if (await page.getByTestId("vector-mute").getAttribute("aria-pressed") !== "true") {
    await page.getByTestId("vector-mute").click();
  }
  await expect(page.getByTestId("vector-mute")).toHaveAttribute("aria-pressed", "true");
  if (await page.getByTestId("vector-low-power").getAttribute("aria-pressed") !== "true") {
    await page.getByTestId("vector-low-power").click();
  }
  await expect(page.getByTestId("vector-low-power")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("vector-volume").fill("0.35");

  await page.getByTestId("vector-controls-toggle").click();
  await expect(page.getByTestId("vector-controls-panel")).toBeVisible();
  await page.getByTestId("vector-offline-toggle").click();
  await expect(page.getByTestId("vector-offline-panel")).toBeVisible();
  await expect(page.getByTestId("vector-storage-status")).toBeVisible();
  const persistStorage = page.getByTestId("vector-storage-persist");
  if (await persistStorage.isEnabled()) await persistStorage.click();

  const fullscreenEnabled = await page.evaluate(() => document.fullscreenEnabled);
  await page.getByTestId("vector-fullscreen").click();
  if (fullscreenEnabled) {
    await expect(page.getByTestId("vector-fullscreen")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("vector-fullscreen").click();
    await expect(page.getByTestId("vector-fullscreen")).toHaveAttribute("aria-pressed", "false");
  } else {
    await expect(page.getByText(/Fullscreen could not be changed/i)).toBeVisible();
  }

  await expect(page.getByTestId("vector-sync-action")).toBeEnabled();
  await page.getByTestId("vector-sync-action").click();
  await expect(page.getByTestId("vector-sync-action")).toBeDisabled({ timeout: 15_000 });
  await page.reload();
  await expectVectorReady(page);
  await expect(page.getByTestId("vector-motion")).toHaveValue("reduced");
  await expect(page.getByTestId("vector-mute")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("vector-low-power")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("vector-volume")).toHaveValue("0.35");

  await page.getByRole("link", { name: "Open game brief" }).click();
  await expect(page).toHaveURL(/\/vector\/second-sense$/);
  await expect(page.getByTestId("vector-game-shell")).toHaveAttribute(
    "data-game-status",
    "available",
  );
  // Second Sense is a real, playable title as of Wave 15.3: the runtime
  // mounts its mode/difficulty select screen instead of the planned gate.
  await expect(page.getByTestId("second-sense-start")).toBeVisible({ timeout: 30_000 });

  expect(failures, `Browser failures:\n${failures.join("\n")}`).toEqual([]);
  expect(loginPrefetches, "Authenticated navigation must not prefetch /login").toEqual([]);

  await page.goto("/vector/not-a-game");
  await expect(page.getByTestId("vector-game-unknown")).toBeVisible();
});

test("VECTOR Instrument Deck remains usable at a narrow mobile viewport", async ({ page }) => {
  const failures = observeBrowserFailures(page);
  await installBiometricPromptAutoDismiss(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/vector");
  await expect(page.getByTestId("vector-lobby")).toBeVisible();
  await expect(page.locator('[data-testid^="vector-game-card-"]')).toHaveCount(9);

  await page.getByTestId("vector-game-card-neon-rift").click();
  await expect(page.getByRole("heading", { name: "Neon Rift", exact: true }).first()).toBeVisible();
  await page.getByTestId("vector-controls-toggle").click();
  await expect(page.getByTestId("vector-controls-panel")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(failures, `Browser failures:\n${failures.join("\n")}`).toEqual([]);
});

test("VECTOR modal contains keyboard focus and restores its trigger", async ({ page }) => {
  test.setTimeout(90_000);
  const failures = observeBrowserFailures(page);
  await installBiometricPromptAutoDismiss(page);
  await page.goto("/vector");
  await expectVectorReady(page);
  await page.getByTestId("vector-offline-toggle").click();

  const trigger = page.getByTestId("vector-clear-data");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Clear owner-scoped VECTOR data" });
  const close = dialog.getByRole("button", { name: "Close" });
  const clear = dialog.getByRole("button", { name: "Clear local records" });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(clear).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.evaluate(() => {
    const outside = document.querySelector<HTMLElement>("[data-testid='vector-offline-toggle']");
    const background = outside
      ? [...document.body.children].find((node) => node.contains(outside))
      : null;
    if (background instanceof HTMLElement) background.inert = false;
    outside?.focus();
  });
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(failures, `Browser failures:\n${failures.join("\n")}`).toEqual([]);
});

test("VECTOR visibly withholds owner records when IndexedDB is unavailable", async ({ page }) => {
  await installBiometricPromptAutoDismiss(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/vector");
  await expect(page.getByTestId("vector-lobby")).toBeVisible();
  await expect(page.getByTestId("vector-data-state")).toHaveAttribute(
    "data-state",
    "unavailable",
  );
  await expect(page.getByText(/does not expose IndexedDB/i)).toBeVisible();
  await expect(page.getByTestId("vector-sync-action")).toBeDisabled();
});

test("VECTOR reports browser quota failure without claiming persisted records", async ({ page }) => {
  await installBiometricPromptAutoDismiss(page);
  await page.addInitScript(() => {
    const quota = () => {
      throw new DOMException("Synthetic VECTOR quota boundary", "QuotaExceededError");
    };
    Object.defineProperty(IDBObjectStore.prototype, "add", {
      configurable: true,
      value: quota,
    });
    Object.defineProperty(IDBObjectStore.prototype, "put", {
      configurable: true,
      value: quota,
    });
  });

  await page.goto("/vector");
  await expect(page.getByTestId("vector-lobby")).toBeVisible();
  await expect(page.getByTestId("vector-data-state")).toHaveAttribute(
    "data-state",
    "quota",
  );
  await expect(page.getByText(/storage is full/i)).toBeVisible();
  await expect(page.getByTestId("vector-sync-action")).toBeDisabled();
  await expect(page.getByTestId("vector-mute")).toBeDisabled();
});

test("VECTOR quarantines checksum-invalid state and requires explicit discard", async ({ page }) => {
  test.setTimeout(180_000);
  const failures = observeBrowserFailures(page);
  await installBiometricPromptAutoDismiss(page);
  await page.goto("/vector");
  await expectVectorReady(page);

  await page.evaluate(async () => {
    const request = indexedDB.open("axis-vector");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = db.transaction("meta", "readonly");
    const ownerRequest = read.objectStore("meta").get("active-owner");
    const deviceRequest = read.objectStore("meta").get("device-id");
    const [ownerRecord, deviceRecord] = await Promise.all([
      new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
        ownerRequest.onsuccess = () => resolve(ownerRequest.result);
        ownerRequest.onerror = () => reject(ownerRequest.error);
      }),
      new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
        deviceRequest.onsuccess = () => resolve(deviceRequest.result);
        deviceRequest.onerror = () => reject(deviceRequest.error);
      }),
    ]);
    const ownerKey = ownerRecord?.value;
    const deviceId = deviceRecord?.value;
    if (typeof ownerKey !== "string" || typeof deviceId !== "string") {
      db.close();
      throw new Error("VECTOR_E2E_OWNER_NOT_READY");
    }
    const write = db.transaction("saves", "readwrite");
    write.objectStore("saves").put({
      id: `${ownerKey}|second-sense|corrupt-main`,
      ownerKey,
      gameId: "second-sense",
      slotId: "corrupt-main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      localRevision: 1,
      serverRevision: 0,
      pendingIdempotencyKey: crypto.randomUUID(),
      deviceId,
      checksum: "0".repeat(64),
      seed: null,
      state: { CORRUPT_SECRET_SENTINEL: "must-never-hydrate" },
      checkpointLabel: "Untrusted checkpoint",
      updatedAt: new Date().toISOString(),
      syncState: ownerKey.startsWith("user:") ? "pending" : "local-only",
      lastErrorCode: null,
    });
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onerror = () => reject(write.error);
      write.onabort = () => reject(write.error);
    });
    db.close();
  });

  await page.reload();
  await expectVectorReady(page);
  await expect(page.getByTestId("vector-featured-conflicts")).toHaveText(/Resolve 1 conflict/);
  await expect(page.getByText("Quarantined save branch")).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain("CORRUPT_SECRET_SENTINEL");

  await page.goto("/vector/second-sense");
  await expect(page.getByTestId("vector-game-conflict")).toBeVisible();
  await expect(page.getByTestId("vector-game-conflict-resolve")).toBeEnabled();
  expect(await page.locator("body").textContent()).not.toContain("CORRUPT_SECRET_SENTINEL");
  await page.getByTestId("vector-game-conflict-resolve").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("The local branch failed checksum validation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export both branches" })).toBeEnabled();
  await expect(page.getByText("Remove the local slot", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm resolution" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("vector-game-conflict")).toHaveCount(0);
  // The conflict was the only thing withholding the runtime; Second Sense is
  // available, so it now mounts its real mode/difficulty select screen.
  await expect(page.getByTestId("second-sense-start")).toBeVisible({ timeout: 30_000 });
  await page.goto("/vector");
  await expect(page.getByTestId("vector-featured-conflicts")).toHaveCount(0);
  await expect(page.getByText("Quarantined save branch")).toHaveCount(0);
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open("axis-vector");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(["meta", "saves", "conflicts"], "readonly");
    const ownerRequest = transaction.objectStore("meta").get("active-owner");
    const saveRequest = transaction.objectStore("saves").getAll();
    const conflictRequest = transaction.objectStore("conflicts").getAll();
    const [ownerRecord, saves, conflicts] = await Promise.all([
      new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
        ownerRequest.onsuccess = () => resolve(ownerRequest.result);
        ownerRequest.onerror = () => reject(ownerRequest.error);
      }),
      new Promise<Array<{ id?: string }>>((resolve, reject) => {
        saveRequest.onsuccess = () => resolve(saveRequest.result);
        saveRequest.onerror = () => reject(saveRequest.error);
      }),
      new Promise<Array<{ ownerKey?: string; slotId?: string; status?: string }>>((resolve, reject) => {
        conflictRequest.onsuccess = () => resolve(conflictRequest.result);
        conflictRequest.onerror = () => reject(conflictRequest.error);
      }),
    ]);
    db.close();
    const ownerKey = ownerRecord?.value;
    if (typeof ownerKey !== "string") throw new Error("VECTOR_E2E_OWNER_NOT_READY");
    return {
      saveExists: saves.some((save) => (
        save.id === `${ownerKey}|second-sense|corrupt-main`
      )),
      conflictStatus: conflicts.find((conflict) => (
        conflict.ownerKey === ownerKey && conflict.slotId === "corrupt-main"
      ))?.status,
    };
  });
  expect(stored).toEqual({ saveExists: false, conflictStatus: "resolved" });
  expect(failures, `Browser failures:\n${failures.join("\n")}`).toEqual([]);
});
