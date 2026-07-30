import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const SOURCE_NOTE_ID = "7f6c1c2e-6a7f-4d2b-8f9e-0a1b2c3d4e51";
const TARGET_TASK_ID = "7f6c1c2e-6a7f-4d2b-8f9e-0a1b2c3d4e52";
const THIRD_PERSON_ID = "7f6c1c2e-6a7f-4d2b-8f9e-0a1b2c3d4e53";
const SOURCE_NOTE_TITLE = "Axis E2E Workspace Alpha";
const TARGET_TASK_TITLE = "Axis E2E Workspace Beta";
const THIRD_PERSON_TITLE = "Axis E2E Workspace Gamma";
const AUTH_COOKIE = /^sb-.*-auth-token(?:\.\d+)?$/;

type AuthState = {
  cookies?: Array<{ name: string; value: string }>;
};

type WorkspaceWireState = {
  version: number;
  activePaneId: string;
  primary: {
    current: string | null;
    back: string[];
    forward: string[];
  };
  panes: Array<{
    id: string;
    widthBps: number;
    current: string;
    back: string[];
    forward: string[];
  }>;
};

let admin: SupabaseClient | null = null;
let ownerId = "";

function localEnvValue(name: string): string {
  if (process.env[name]) return process.env[name] as string;

  const envPath = path.resolve(process.cwd(), ".env.local");
  const source = fs.readFileSync(envPath, "utf8");
  const line = source
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is required for authenticated workspace E2E.`);

  const raw = line.slice(name.length + 1).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function accessTokenFromAuthState(): string {
  const statePath = path.resolve(
    process.cwd(),
    process.env.E2E_AUTH_STATE ?? ".auth/e2e-user.json",
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as AuthState;
  const matchingCookies = (state.cookies ?? []).filter((cookie) =>
    AUTH_COOKIE.test(cookie.name),
  );
  if (matchingCookies.length === 0) {
    throw new Error("The authenticated Playwright storage state has no Supabase session.");
  }

  const unchunked = matchingCookies.find((cookie) =>
    cookie.name.endsWith("-auth-token"),
  );
  const encoded = unchunked
    ? unchunked.value
    : matchingCookies
        .sort((left, right) => {
          const leftIndex = Number(left.name.match(/\.(\d+)$/)?.[1] ?? 0);
          const rightIndex = Number(right.name.match(/\.(\d+)$/)?.[1] ?? 0);
          return leftIndex - rightIndex;
        })
        .map((cookie) => cookie.value)
        .join("");

  const cookieValue = decodeURIComponent(encoded);
  const serialized = cookieValue.startsWith("base64-")
    ? decodeBase64Url(cookieValue.slice("base64-".length))
    : cookieValue;
  const session = JSON.parse(serialized) as
    | { access_token?: unknown }
    | [unknown, ...unknown[]];
  const token = Array.isArray(session) ? session[0] : session.access_token;
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("The authenticated Playwright storage state has an invalid Supabase session.");
  }
  return token;
}

function ownerIdFromAccessToken(token: string): string {
  const payload = JSON.parse(decodeBase64Url(token.split(".")[1])) as {
    sub?: unknown;
  };
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("The authenticated Supabase session has no owner id.");
  }
  return payload.sub;
}

function workspaceStateFromUrl(url: string): WorkspaceWireState {
  const encoded = new URL(url).searchParams.get("ws");
  if (!encoded) throw new Error("Expected a serialized workspace in the URL.");
  return JSON.parse(decodeBase64Url(encoded)) as WorkspaceWireState;
}

async function assertNoSupabaseError(
  operation: string,
  result: PromiseLike<{ error: { message: string } | null }>,
): Promise<void> {
  const { error } = await result;
  if (error) throw new Error(`${operation} failed: ${error.message}`);
}

async function cleanWorkspaceFixture(): Promise<void> {
  if (!admin || !ownerId) return;
  const ids = [SOURCE_NOTE_ID, TARGET_TASK_ID, THIRD_PERSON_ID];

  await assertNoSupabaseError(
    "Clean outgoing entity references",
    admin
      .from("entity_references")
      .delete()
      .eq("user_id", ownerId)
      .in("source_id", ids),
  );
  await assertNoSupabaseError(
    "Clean backlink entity references",
    admin
      .from("entity_references")
      .delete()
      .eq("user_id", ownerId)
      .in("target_id", ids),
  );
  await assertNoSupabaseError(
    "Clean entity usage",
    admin
      .from("entity_usage")
      .delete()
      .eq("user_id", ownerId)
      .in("entity_id", ids),
  );
  await assertNoSupabaseError(
    "Clean source note",
    admin.from("notes").delete().eq("id", SOURCE_NOTE_ID).eq("user_id", ownerId),
  );
  await assertNoSupabaseError(
    "Clean target task",
    admin
      .from("agent_tasks")
      .delete()
      .eq("id", TARGET_TASK_ID)
      .eq("user_id", ownerId),
  );
  await assertNoSupabaseError(
    "Clean third person",
    admin
      .from("people")
      .delete()
      .eq("id", THIRD_PERSON_ID)
      .eq("user_id", ownerId),
  );
}

async function searchUsageCount(): Promise<number> {
  if (!admin || !ownerId) throw new Error("Workspace fixture is not initialized.");
  const { data, error } = await admin
    .from("entity_usage")
    .select("search_select_count")
    .eq("user_id", ownerId)
    .eq("entity_kind", "note")
    .eq("entity_id", SOURCE_NOTE_ID)
    .maybeSingle();
  if (error) throw new Error(`Read entity usage failed: ${error.message}`);
  return Number(data?.search_select_count ?? 0);
}

async function openSearchWithShortcut(
  page: Page,
  shortcutModifier: "Meta" | "Control",
) {
  const searchDialog = page.getByRole("dialog", { name: "Search Axis" });

  // `goto(..., domcontentloaded)` can resolve before the client AppShell has
  // installed its document-level shortcut listener. Exercise the visible
  // trigger once as a hydration readiness barrier, then close it and assert
  // the actual keyboard shortcut opens the same dialog. This preserves the
  // shortcut contract instead of accepting a retry-only pass on slower CI.
  const searchTrigger = page.getByTitle("Search Axis (⌘/)");
  await expect(searchTrigger).toBeVisible();
  await searchTrigger.click();
  await expect(searchDialog).toBeVisible();
  await searchDialog.getByRole("button", { name: "Close search" }).click();
  await expect(searchDialog).toHaveCount(0);

  await page.keyboard.press(`${shortcutModifier}+Slash`);
  await expect(searchDialog).toBeVisible();
  return searchDialog;
}

test.beforeAll(async () => {
  const accessToken = accessTokenFromAuthState();
  ownerId = ownerIdFromAccessToken(accessToken);
  admin = createClient(
    localEnvValue("NEXT_PUBLIC_SUPABASE_URL"),
    localEnvValue("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  await cleanWorkspaceFixture();
  await assertNoSupabaseError(
    "Seed source note",
    admin.from("notes").upsert(
      {
        id: SOURCE_NOTE_ID,
        user_id: ownerId,
        title: SOURCE_NOTE_TITLE,
        body: "Owner-scoped source evidence for the entity workspace browser test.",
        folder: "E2E",
        tags: ["e2e", "workspace"],
        sort_order: 0,
      },
      { onConflict: "id" },
    ),
  );
  await assertNoSupabaseError(
    "Seed target task",
    admin.from("agent_tasks").upsert(
      {
        id: TARGET_TASK_ID,
        user_id: ownerId,
        objective: TARGET_TASK_TITLE,
        status: "queued",
        context: { source: "authenticated-e2e" },
        source_skill: "workspace-e2e",
      },
      { onConflict: "id" },
    ),
  );
  await assertNoSupabaseError(
    "Seed third person",
    admin.from("people").upsert(
      {
        id: THIRD_PERSON_ID,
        user_id: ownerId,
        name: THIRD_PERSON_TITLE,
        role: "Workspace limit fixture",
        note: "Owner-scoped third entity for pane-cap testing.",
        tag: "collaborator",
      },
      { onConflict: "id" },
    ),
  );
});

test.afterAll(async () => {
  await cleanWorkspaceFixture();
});

test("entity search, references, pane history, and responsive workspace restore end to end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const shortcutModifier = process.platform === "darwin" ? "Meta" : "Control";

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/command");
  await expect(page.locator("body")).not.toContainText(
    /application error|runtime error/i,
  );

  const searchDialog = await openSearchWithShortcut(page, shortcutModifier);
  const entitySearch = searchDialog.getByPlaceholder(
    "Search notes, tasks, people, approvals…",
  );
  await expect(entitySearch).toBeFocused();
  await entitySearch.fill(SOURCE_NOTE_TITLE);

  await expect(
    searchDialog.getByRole("option").filter({ hasText: SOURCE_NOTE_TITLE }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    searchDialog.getByRole("heading", {
      name: SOURCE_NOTE_TITLE,
      exact: true,
    }),
  ).toBeVisible({ timeout: 20_000 });

  // Search-result previews are read-only. Usage changes only after activation.
  await expect.poll(searchUsageCount).toBe(0);
  await searchDialog.getByRole("button", { name: "Open in workspace" }).click();
  await expect(searchDialog).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]ws=[A-Za-z0-9_-]+/);

  const openedUrl = page.url();
  expect(openedUrl).not.toContain(SOURCE_NOTE_ID);
  const openedState = workspaceStateFromUrl(openedUrl);
  expect(openedState.activePaneId).toBe("pane-1");
  expect(openedState.panes).toHaveLength(1);
  expect(openedState.panes[0]).toMatchObject({
    id: "pane-1",
    widthBps: 3600,
    current: `note:${SOURCE_NOTE_ID}`,
    back: [],
    forward: [],
  });
  await expect.poll(searchUsageCount).toBe(1);

  const notePane = page.getByRole("region", { name: "Note evidence pane" });
  await expect(
    notePane.getByRole("heading", { name: SOURCE_NOTE_TITLE, exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/command$/);
  await expect(notePane).toHaveCount(0);
  await page.goForward();
  await expect(notePane).toBeVisible();
  await expect.poll(searchUsageCount).toBe(1);

  await page.keyboard.press(`${shortcutModifier}+Slash`);
  await expect(searchDialog).toBeVisible();
  await entitySearch.fill(TARGET_TASK_TITLE);
  await expect(
    searchDialog.getByRole("option").filter({ hasText: TARGET_TASK_TITLE }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    searchDialog.getByRole("heading", {
      name: TARGET_TASK_TITLE,
      exact: true,
    }),
  ).toBeVisible({ timeout: 20_000 });
  await searchDialog
    .getByRole("button", { name: "Link to current pane" })
    .click();
  await expect(
    searchDialog.getByRole("status").filter({
      hasText: `${TARGET_TASK_TITLE} linked to the current pane.`,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(searchDialog).toHaveCount(0);

  const targetReference = notePane.getByRole("button", {
    name: `Open ${TARGET_TASK_TITLE} in this pane`,
  });
  await expect(targetReference).toBeVisible();
  await targetReference.click();

  const taskPane = page.getByRole("region", { name: "Task evidence pane" });
  await expect(
    taskPane.getByRole("heading", { name: TARGET_TASK_TITLE, exact: true }),
  ).toBeVisible();
  await expect(
    taskPane.getByRole("button", {
      name: `Open ${SOURCE_NOTE_TITLE} in this pane`,
    }),
  ).toBeVisible();
  expect(workspaceStateFromUrl(page.url()).panes[0]).toMatchObject({
    current: `task:${TARGET_TASK_ID}`,
    back: [`note:${SOURCE_NOTE_ID}`],
    forward: [],
  });

  await taskPane
    .getByRole("button", { name: "Go back in Task pane" })
    .click();
  await expect(
    notePane.getByRole("heading", { name: SOURCE_NOTE_TITLE, exact: true }),
  ).toBeVisible();
  await notePane
    .getByRole("button", { name: "Go forward in Note pane" })
    .click();
  await expect(
    taskPane.getByRole("heading", { name: TARGET_TASK_TITLE, exact: true }),
  ).toBeVisible();

  const stateBeforeReload = workspaceStateFromUrl(page.url());
  await page.reload();
  await expect(
    taskPane.getByRole("heading", { name: TARGET_TASK_TITLE, exact: true }),
  ).toBeVisible();
  expect(workspaceStateFromUrl(page.url())).toEqual(stateBeforeReload);

  const separator = page.getByRole("separator", {
    name: "Resize Task pane",
  });
  await expect(separator).toHaveAttribute("aria-valuenow", "36");
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "37");
  await expect
    .poll(() => workspaceStateFromUrl(page.url()).panes[0]?.widthBps)
    .toBe(3700);

  await page.keyboard.press(`${shortcutModifier}+k`);
  const commandDialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(commandDialog).toBeVisible();
  await commandDialog
    .getByRole("combobox", { name: "Find a command" })
    .fill("Focus Next Pane");
  await commandDialog
    .getByRole("option")
    .filter({ hasText: "Focus Next Pane" })
    .click();
  await expect(commandDialog).toHaveCount(0);
  await expect
    .poll(() => workspaceStateFromUrl(page.url()).activePaneId)
    .toBe("primary");

  page.once("dialog", (dialog) => dialog.accept());
  await taskPane
    .getByRole("button", { name: `Remove reference to ${SOURCE_NOTE_TITLE}` })
    .click();
  await expect(
    taskPane.getByRole("button", {
      name: `Open ${SOURCE_NOTE_TITLE} in this pane`,
    }),
  ).toHaveCount(0);

  await page.keyboard.press(`${shortcutModifier}+Slash`);
  await entitySearch.fill(SOURCE_NOTE_TITLE);
  await expect(
    searchDialog.getByRole("option").filter({ hasText: SOURCE_NOTE_TITLE }),
  ).toBeVisible({ timeout: 20_000 });
  await searchDialog.getByRole("button", { name: "Open in workspace" }).click();
  await expect(searchDialog).toHaveCount(0);
  const twoPaneState = workspaceStateFromUrl(page.url());
  expect(twoPaneState.panes).toHaveLength(2);
  expect(
    twoPaneState.panes.reduce((total, pane) => total + pane.widthBps, 0),
  ).toBeLessThanOrEqual(7200);

  const secondNotePane = page.getByRole("region", { name: "Note evidence pane" });
  await expect(secondNotePane).toBeVisible();
  const taskSeparator = page.getByRole("separator", { name: "Resize Task pane" });
  const noteSeparator = page.getByRole("separator", { name: "Resize Note pane" });
  await noteSeparator.press("Home");
  await expect(noteSeparator).toHaveAttribute("aria-valuenow", "18");
  await taskSeparator.press("End");
  await expect(taskSeparator).toHaveAttribute("aria-valuenow", "54");
  await expect
    .poll(() =>
      workspaceStateFromUrl(page.url()).panes.reduce(
        (total, pane) => total + pane.widthBps,
        0,
      ),
    )
    .toBe(7200);

  await page.keyboard.press(`${shortcutModifier}+Slash`);
  await entitySearch.fill(THIRD_PERSON_TITLE);
  await expect(
    searchDialog.getByRole("option").filter({ hasText: THIRD_PERSON_TITLE }),
  ).toBeVisible({ timeout: 20_000 });
  await searchDialog.getByRole("button", { name: "Open in workspace" }).click();
  await expect(
    searchDialog.getByRole("alert").filter({
      hasText: "maximum number of panes",
    }),
  ).toBeVisible();
  expect(workspaceStateFromUrl(page.url()).panes).toHaveLength(2);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 820 });
  const paneTabs = page.getByRole("tablist", { name: "Workspace panes" });
  await expect(paneTabs).toBeVisible();
  const workspaceTab = paneTabs.getByRole("tab", { name: "Workspace" });
  const taskTab = paneTabs.getByRole("tab", { name: "Task" });
  const noteTab = paneTabs.getByRole("tab", { name: "Note" });
  await expect(noteTab).toHaveAttribute("aria-selected", "true");
  await noteTab.focus();
  await noteTab.press("Home");
  await expect(workspaceTab).toHaveAttribute("aria-selected", "true");
  await expect(workspaceTab).toBeFocused();
  await taskTab.click();
  await expect(
    page.getByRole("tabpanel", { name: "Task evidence pane" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await secondNotePane
    .getByRole("button", { name: "Close Note pane" })
    .click();
  await expect(secondNotePane).toHaveCount(0);

  await taskPane.getByRole("link", { name: "Open full page" }).click();
  await expect(page).toHaveURL(/\/tasks\?/);
  const fullPageUrl = new URL(page.url());
  expect(fullPageUrl.searchParams.get("task")).toBe(
    `task:${TARGET_TASK_ID}`,
  );
  await expect.poll(() => new URL(page.url()).searchParams.get("ws")).toBeNull();
  await expect(
    page.getByRole("heading", { name: TARGET_TASK_TITLE, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Task evidence pane" })).toHaveCount(0);
});

test("invalid workspace URL state is visible and resettable without losing other query state", async ({
  page,
}) => {
  await page.goto("/command?view=focus&ws=not-valid!");
  const recovery = page.getByRole("alert", {
    name: "This workspace link could not be restored",
  });
  await expect(recovery).toBeVisible();
  await page.getByRole("button", { name: "Reset workspace" }).click();
  await expect(page).toHaveURL(/\/command\?view=focus$/);
  await expect(recovery).toHaveCount(0);
});

test("search exposes partial and preview-error states with retry", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route("**/api/entities/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        results: [{
          ref: { kind: "note", id: SOURCE_NOTE_ID },
          title: SOURCE_NOTE_TITLE,
          href: "/notes",
          meta: [],
          ranking: {
            text: 100,
            usage: 0,
            freshness: 0,
            total: 100,
            reasons: ["Title match"],
          },
        }],
        sources: [
          { kind: "note", status: "ok", count: 1 },
          { kind: "usage", status: "unavailable", count: 0 },
        ],
        partial: true,
      }),
    });
  });
  await page.route(`**/api/entities/note/${SOURCE_NOTE_ID}`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "ENTITY_UNAVAILABLE" }),
    });
  });

  await page.goto("/command");
  await page.getByTitle(/Search Axis/).click();
  const dialog = page.getByRole("dialog", { name: "Search Axis" });
  await dialog
    .getByPlaceholder("Search notes, tasks, people, approvals…")
    .fill(SOURCE_NOTE_TITLE);
  await expect(dialog.getByText("Partial results.")).toBeVisible();
  await expect(
    dialog.getByText("Preview is temporarily unavailable. Try again."),
  ).toBeVisible();
  await page.unroute(`**/api/entities/note/${SOURCE_NOTE_ID}`);
  await dialog.getByRole("button", { name: "Retry preview" }).click();
  await expect(
    dialog.getByRole("heading", { name: SOURCE_NOTE_TITLE, exact: true }),
  ).toBeVisible();
});
