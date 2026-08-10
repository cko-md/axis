// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shellProfile: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname: () => "/fund" }));
vi.mock("@/components/layout/ShellProfileContext", () => ({ useShellProfile: mocks.shellProfile }));
vi.mock("@/components/ui/axis/ModuleInteractiveHero", () => ({
  ModuleInteractiveHero: ({ children, subtitle, actions }: { children: ReactNode; subtitle: string; actions: Array<{ label: string }> }) => (
    <div><span>{subtitle}</span><span>{actions[0]?.label}</span>{children}</div>
  ),
}));
vi.mock("@/components/fund/FundSubNav", () => ({ FundSubNav: () => null }));
vi.mock("@/components/ui/FreshnessBadge", () => ({ FreshnessBadge: ({ retrievedAt }: { retrievedAt?: string | null }) => <span>{retrievedAt ?? "no-freshness"}</span> }));

import { FundPremiumShell } from "./FundPremiumShell";

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle() {
  for (let index = 0; index < 5; index++) {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
}

describe("Fund provider-shell subject boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    mocks.shellProfile.mockReturnValue({ state: "ready", profile: { subject: SUBJECT_A }, authorityEpoch: 1 });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("masks A metadata synchronously and ignores delayed A status bodies under B", async () => {
    let resolveAPlaid: ((value: unknown) => void) | null = null;
    let resolveABrokerage: ((value: unknown) => void) | null = null;
    const delayedAPlaid = new Promise((resolve) => { resolveAPlaid = resolve; });
    const delayedABrokerage = new Promise((resolve) => { resolveABrokerage = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://axis.test").pathname;
      if (path === "/api/massive/status") return { ok: true, json: async () => ({ configured: true }) } as Response;
      const subject = new Headers(init?.headers).get("x-axis-expected-profile-subject");
      if (subject === SUBJECT_A && path === "/api/plaid/status") return { ok: true, json: () => delayedAPlaid } as Response;
      if (subject === SUBJECT_A && path === "/api/brokerage/status") return { ok: true, json: () => delayedABrokerage } as Response;
      if (subject === SUBJECT_B && (path === "/api/plaid/status" || path === "/api/brokerage/status")) {
        return { ok: true, json: async () => ({ configured: false, linked: false }) } as Response;
      }
      throw new Error(`Unexpected status request ${path} for ${subject}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root?.render(<FundPremiumShell><div>content</div></FundPremiumShell>));
    await settle();
    mocks.shellProfile.mockReturnValue({ state: "ready", profile: { subject: SUBJECT_B }, authorityEpoch: 2 });
    flushSync(() => root?.render(<FundPremiumShell><div>content</div></FundPremiumShell>));

    expect(container?.textContent).not.toContain("Connected");
    expect(container?.textContent).toContain("Refreshing…");
    await settle();
    expect(container?.textContent).toContain("Not configured");
    await act(async () => {
      resolveAPlaid?.({ configured: true, linked: true, connection: { status: "linked", updatedAt: "2026-08-09T20:00:00.000Z" } });
      resolveABrokerage?.({ configured: true, linked: true, latestConnection: { status: "linked", updatedAt: "2026-08-09T20:00:00.000Z" } });
      await Promise.resolve();
    });
    await settle();

    expect(container?.textContent).not.toContain("Connected");
    expect(container?.textContent).not.toContain("2026-08-09T20:00:00.000Z");
  });
});
