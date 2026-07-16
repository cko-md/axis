import { expect, test } from "@playwright/test";

const PREFERENCES_ROUTE = "**/rest/v1/user_preferences**";

test("a late remote preference read cannot overwrite a user theme edit", async ({
  page,
}) => {
  let releaseRead!: () => void;
  let observedRead!: () => void;
  const readObserved = new Promise<void>((resolve) => {
    observedRead = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let delayNextRead = true;

  await page.route(PREFERENCES_ROUTE, async (route) => {
    if (route.request().method() === "GET" && delayNextRead) {
      delayNextRead = false;
      observedRead();
      await readGate;
    }
    await route.continue();
  });

  await page.goto("/design-system");
  await readObserved;
  const dim = page
    .getByRole("group", { name: "Color theme" })
    .getByRole("button", { name: "Dim", exact: true });
  await dim.click();
  await expect(dim).toHaveAttribute("aria-pressed", "true");
  releaseRead();
  await expect(dim).toHaveAttribute("aria-pressed", "true");

  await page.waitForTimeout(700);
  await page.unroute(PREFERENCES_ROUTE);
  await page.reload();
  await expect(dim).toHaveAttribute("aria-pressed", "true");
});

test("a failed remote preference read never triggers a blind upsert", async ({
  page,
}) => {
  let writes = 0;
  await page.route(PREFERENCES_ROUTE, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "TEST_READ_FAILURE" }),
      });
      return;
    }
    writes += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: "[]",
    });
  });

  await page.goto("/design-system");
  const slate = page
    .getByRole("group", { name: "Color theme" })
    .getByRole("button", { name: "Slate", exact: true });
  await slate.click();
  await expect(slate).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(700);
  expect(writes).toBe(0);
});
