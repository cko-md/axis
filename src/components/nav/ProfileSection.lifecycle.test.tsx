// @vitest-environment jsdom

import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShellProfileContext,
  type ShellProfileContextValue,
} from "@/components/layout/ShellProfileContext";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("react-easy-crop", () => ({ default: () => null }));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) => (
    open ? <section data-testid="profile-modal">{children}</section> : null
  ),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("./cropImage", () => ({
  getCroppedImageBlob: vi.fn(),
}));

import { ProfileSection, profileInitials } from "./ProfileSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const profile = {
  subject: `ps1_${"a".repeat(64)}`,
  display_name: "Owner A",
  role_title: "Private Role A",
  bio: null,
  avatar_url: null,
  email: "owner-a@example.test",
};

function contextValue(
  overrides: Partial<ShellProfileContextValue> = {},
): ShellProfileContextValue {
  return {
    state: "ready",
    profile,
    draft: {
      name: "Private Draft A",
      role: "Private Role A",
      bio: "Former-subject private draft",
      photo: "",
    },
    saveState: "idle",
    uploadState: "idle",
    hasPendingChanges: false,
    scheduleProfileSave: vi.fn(),
    retryProfileSave: vi.fn(),
    uploadProfilePhoto: vi.fn(),
    processAndUploadProfilePhoto: vi.fn(),
    cancelProfilePhotoProcessing: vi.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;

async function renderProfile(value: ShellProfileContextValue) {
  act(() => root?.render(
    <ShellProfileContext.Provider value={value}>
      <ProfileSection onSignOut={vi.fn()} />
    </ShellProfileContext.Provider>,
  ));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function ProfileBoundary({ value }: { value: ShellProfileContextValue }) {
  const [profileName, setProfileName] = useState<string | undefined>();
  return (
    <ShellProfileContext.Provider value={value}>
      <output data-testid="wordmark">AXIS[{profileInitials(profileName)}]</output>
      <ProfileSection onSignOut={vi.fn()} onProfileName={setProfileName} />
    </ShellProfileContext.Provider>
  );
}

async function renderBoundary(value: ShellProfileContextValue) {
  act(() => root?.render(<ProfileBoundary value={value} />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.toast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("ProfileSection lifecycle quarantine", () => {
  it("clears former-subject initials while identity is unresolved", async () => {
    await renderBoundary(contextValue());
    expect(container.querySelector('[data-testid="wordmark"]')?.textContent).toBe("AXIS[OA]");

    await renderBoundary(contextValue({ state: "loading", profile: null }));

    expect(container.querySelector('[data-testid="wordmark"]')?.textContent).toBe("AXIS[CKO]");
    expect(container.textContent).not.toContain("AXIS[OA]");
  });

  it("closes and hides an open former-subject modal while identity is unresolved", async () => {
    await renderProfile(contextValue());
    const profileButton = container.querySelector<HTMLElement>(".profile");
    act(() => profileButton?.click());
    expect(container.querySelector('[data-testid="profile-modal"]')).not.toBeNull();
    expect(container.textContent).toContain("Private Draft A");

    await renderProfile(contextValue({ state: "loading", profile: null }));

    expect(container.querySelector('[data-testid="profile-modal"]')).toBeNull();
    expect(container.textContent).not.toContain("Private Draft A");
    expect(container.textContent).not.toContain("Former-subject private draft");
    expect(container.textContent).not.toContain("owner-a@example.test");
  });
});
