// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROFILE_FIELD_LENGTH,
  ShellProfileContext,
  type ShellProfileContextValue,
} from "@/components/layout/ShellProfileContext";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  toast: vi.fn(),
  fetch: vi.fn(),
  profileName: vi.fn(),
  schedule: vi.fn(),
  retry: vi.fn(),
  upload: vi.fn(),
  process: vi.fn(),
  cancelProcessing: vi.fn(),
  crop: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.capture,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("react-easy-crop", () => ({
  default: ({
    onCropComplete,
  }: {
    onCropComplete: (area: unknown, areaPixels: unknown) => void;
  }) => (
    <button
      id="complete-crop"
      onClick={() =>
        onCropComplete(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 0, y: 0, width: 10, height: 10 },
        )
      }
    >
      Complete crop
    </button>
  ),
}));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <>
      {children}
      {footer}
    </>
  ),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("./cropImage", () => ({
  getCroppedImageBlob: mocks.crop,
}));

import { ProfileSection } from "./ProfileSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const profile = {
  subject: `ps1_${"a".repeat(64)}`,
  display_name: "Name",
  role_title: "Role",
  bio: null,
  avatar_url: null,
  email: "account@example.test",
};

function contextValue(
  overrides: Partial<ShellProfileContextValue> = {},
): ShellProfileContextValue {
  return {
    state: "ready",
    profile,
    draft: {
      name: "Name",
      role: "Role",
      bio: "",
      photo: "",
    },
    saveState: "idle",
    uploadState: "idle",
    hasPendingChanges: false,
    scheduleProfileSave: mocks.schedule,
    retryProfileSave: mocks.retry,
    uploadProfilePhoto: mocks.upload,
    processAndUploadProfilePhoto: mocks.process,
    cancelProfilePhotoProcessing: mocks.cancelProcessing,
    ...overrides,
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let container: HTMLDivElement;
let root: Root | null;

async function renderProfile(value = contextValue()) {
  act(() => {
    root?.render(
      <ShellProfileContext.Provider value={value}>
        <ProfileSection
          onSignOut={vi.fn()}
          onProfileName={mocks.profileName}
        />
      </ShellProfileContext.Provider>,
    );
  });
  await act(flush);
}

function setInput(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing input ${selector}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:avatar"),
    revokeObjectURL: vi.fn(),
  });
  mocks.crop.mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ProfileSection", () => {
  it("renders root-owned draft state and delegates a full bounded edit", async () => {
    await renderProfile();

    const name = setInput("#profile-name", "Saved Name");

    expect(name.maxLength).toBe(MAX_PROFILE_FIELD_LENGTH);
    expect(
      container.querySelector<HTMLInputElement>("#profile-role")?.maxLength,
    ).toBe(MAX_PROFILE_FIELD_LENGTH);
    expect(
      container.querySelector<HTMLTextAreaElement>("#profile-bio")?.maxLength,
    ).toBe(MAX_PROFILE_FIELD_LENGTH);
    expect(mocks.schedule).toHaveBeenCalledWith({
      name: "Saved Name",
      role: "Role",
      bio: "",
      photo: "",
    });
    expect(mocks.profileName).toHaveBeenCalledWith("Name");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses honest retained-change copy and exposes an explicit retry", async () => {
    await renderProfile(
      contextValue({
        saveState: "error",
        hasPendingChanges: true,
      }),
    );

    expect(container.textContent).toContain("Save failed — changes kept");
    expect(container.textContent).not.toContain("Retry pending");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry save",
    );
    act(() => retry?.click());
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("keeps session-expired feedback actionable", async () => {
    await renderProfile(
      contextValue({
        state: "signed-out",
        saveState: "session-expired",
        hasPendingChanges: true,
      }),
    );

    expect(container.textContent).toContain(
      "Session expired — changes not saved",
    );
    expect(
      container.querySelector<HTMLAnchorElement>('a[href="/login"]'),
    ).not.toBeNull();
  });

  it("keeps MFA feedback actionable", async () => {
    await renderProfile(
      contextValue({
        state: "mfa-required",
        saveState: "idle",
        hasPendingChanges: true,
      }),
    );

    expect(container.textContent).toContain(
      "Two-factor authentication required",
    );
    expect(
      container.querySelector<HTMLAnchorElement>(
        'a[href="/login?mfa=required"]',
      ),
    ).not.toBeNull();
  });

  it("hands a crop to the persistent owner with the initiating subject after unmount", async () => {
    let resolveProcessing!: () => void;
    mocks.process.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        }),
    );
    await renderProfile();

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Missing avatar file input");
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["image"], "avatar.jpg", { type: "image/jpeg" })],
    });
    act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    act(() =>
      container.querySelector<HTMLButtonElement>("#complete-crop")?.click(),
    );
    const savePhoto = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    act(() => savePhoto?.click());
    await act(flush);
    expect(mocks.process).toHaveBeenCalledWith(
      "blob:avatar",
      { x: 0, y: 0, width: 10, height: 10 },
      profile.subject,
    );

    act(() => root?.render(<div>Different route</div>));
    resolveProcessing();
    await act(flush);

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
