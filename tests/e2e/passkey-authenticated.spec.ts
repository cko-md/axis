import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type PasskeyRecord = {
  id: string;
  name: string;
};

type VirtualAuthenticator = {
  authenticatorId: string;
};

const passkeyE2EEnabled = process.env.AXIS_E2E_PASSKEY === "1";

async function passkeys(page: Page): Promise<PasskeyRecord[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/passkey/list");
    if (!response.ok) throw new Error(`Passkey list failed with ${response.status}`);
    const body = await response.json();
    return Array.isArray(body) ? body : (body.passkeys ?? []);
  });
}

async function deletePasskey(page: Page, passkeyId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const response = await fetch("/api/auth/passkey/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passkeyId: id }),
    });
    if (!response.ok && response.status !== 401) {
      throw new Error(`Passkey delete failed with ${response.status}`);
    }
  }, passkeyId);
}

async function dismissBiometricPrompt(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", {
    name: /Use Face ID \/ Touch ID for faster sign-in\?/i,
  });
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Not now" }).click();
  }
}

async function openAuthenticatedControlRoom(page: Page): Promise<void> {
  await page.goto("/control-room", { waitUntil: "domcontentloaded" });
  if (/\/login/.test(page.url())) {
    const email = process.env.E2E_USER_EMAIL;
    const password = process.env.E2E_USER_PASSWORD;
    if (!email || !password) {
      throw new Error("Passkey E2E auth state expired; E2E_USER_EMAIL and E2E_USER_PASSWORD are required");
    }
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: /^Sign in$/ }).click();
    await expect(page).toHaveURL(/\/(command|console)$/);
    await page.goto("/control-room", { waitUntil: "domcontentloaded" });
  }
  await expect(page).toHaveURL(/\/control-room$/);
}

async function openSecurityTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);
}

async function attachViewport(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const body = await page.screenshot({ type: "png", fullPage: false });
  await testInfo.attach(name, {
    body,
    contentType: "image/png",
  });
  const screenshotDir = process.env.AXIS_E2E_SCREENSHOT_DIR;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    writeFileSync(path.join(screenshotDir, `${name}.png`), body);
  }
}

test.skip(
  !passkeyE2EEnabled,
  "Set AXIS_E2E_PASSKEY=1 with an isolated local authenticated user and service-role configuration.",
);

test("platform passkey registers, signs out, and restores a fresh authenticated session", async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe("chromium");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })) as VirtualAuthenticator;

  let registeredPasskeyId: string | null = null;

  try {
    await openAuthenticatedControlRoom(page);
    await dismissBiometricPrompt(page);
    await openSecurityTab(page);

    for (const existing of await passkeys(page)) {
      await deletePasskey(page, existing.id);
    }
    if ((await passkeys(page)).length > 0) {
      throw new Error("Could not establish an empty passkey fixture");
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissBiometricPrompt(page);
    await openSecurityTab(page);
    await expect(page.getByText("No passkeys registered.")).toBeVisible();

    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect(page.getByText("My device", { exact: true })).toBeVisible();

    const registered = await passkeys(page);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("My device");
    registeredPasskeyId = registered[0]?.id ?? null;
    expect(registeredPasskeyId).not.toBeNull();
    await attachViewport(page, testInfo, "passkey-registered");

    await page.getByRole("button", { name: "Data & Privacy", exact: true }).click();
    const dataPanel = page.locator(".subpanel.on");
    await dataPanel.getByRole("button", { name: "Sign out", exact: true }).click();
    const signOutDialog = page.getByRole("dialog", { name: "Sign out" });
    await expect(signOutDialog).toBeVisible();
    await signOutDialog.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page).toHaveURL(/\/login$/);
    const passkeyButton = page.getByRole("button", {
      name: "Sign in with Face ID / Touch ID",
    });
    await expect(passkeyButton).toBeEnabled();
    await attachViewport(page, testInfo, "passkey-signed-out");

    await passkeyButton.click();
    await expect(page).toHaveURL(/\/command$/, { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(/application error|runtime error/i);

    const authStatus = await page.evaluate(async () => {
      const response = await fetch("/api/auth/settings");
      return response.status;
    });
    expect(authStatus).toBe(200);
    await attachViewport(page, testInfo, "passkey-restored-session");

    await page.goto("/control-room", { waitUntil: "domcontentloaded" });
    await dismissBiometricPrompt(page);
    await openSecurityTab(page);
    await deletePasskey(page, registeredPasskeyId!);
    registeredPasskeyId = null;
    expect(await passkeys(page)).toHaveLength(0);
  } finally {
    if (registeredPasskeyId) {
      await deletePasskey(page, registeredPasskeyId).catch(() => {});
    }
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    await cdp.send("WebAuthn.disable").catch(() => {});
  }
});
