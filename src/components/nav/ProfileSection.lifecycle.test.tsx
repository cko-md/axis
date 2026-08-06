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
  process: vi.fn(),
  createObjectURL: vi.fn(() => "blob:retained-avatar"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("react-easy-crop", () => ({
  default: ({
    zoom,
    onCropComplete,
  }: {
    zoom: number;
    onCropComplete: (area: unknown, areaPixels: unknown) => void;
  }) => (
    <>
      <output data-testid="crop-zoom">{zoom}</output>
      <button
        type="button"
        data-testid="complete-crop"
        onClick={() => onCropComplete(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 3, y: 4, width: 10, height: 10 },
        )}
      >
        Complete crop
      </button>
    </>
  ),
}));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, footer, open }: { children: React.ReactNode; footer: React.ReactNode; open: boolean }) => (
    open ? <section data-testid="profile-modal">{children}{footer}</section> : null
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
    processAndUploadProfilePhoto: mocks.process,
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
  mocks.process.mockReset();
  mocks.createObjectURL.mockClear();
  mocks.revokeObjectURL.mockClear();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: mocks.createObjectURL,
    revokeObjectURL: mocks.revokeObjectURL,
  });
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

async function beginCrop() {
  const profileButton = container.querySelector<HTMLElement>(".profile");
  act(() => profileButton?.click());
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) throw new Error("Missing avatar file input");
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [new File(["image"], "avatar.jpg", { type: "image/jpeg" })],
  });
  act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => Promise.resolve());
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="complete-crop"]')?.click());
  const zoom = container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]');
  if (!zoom) throw new Error("Missing crop zoom control");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(zoom, "2");
    zoom.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="crop-zoom"]')?.textContent).toBe("2");
  const savePhoto = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Save Photo",
  );
  expect(savePhoto?.disabled).toBe(false);
}

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

  it("quarantines an unfinished crop until the same subject is restored", async () => {
    await renderProfile(contextValue());
    await beginCrop();

    await renderProfile(contextValue({ state: "loading", profile: null }));
    expect(container.querySelector('[data-testid="profile-modal"]')).toBeNull();
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();

    await renderProfile(contextValue());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="crop-zoom"]')?.textContent).toBe("2");
    const savePhoto = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    expect(savePhoto?.disabled).toBe(false);
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("discards an unfinished crop visibly after a different subject resolves", async () => {
    await renderProfile(contextValue());
    await beginCrop();

    await renderProfile(contextValue({ state: "loading", profile: null }));
    expect(container.querySelector('[data-testid="profile-modal"]')).toBeNull();

    await renderProfile(contextValue({
      profile: { ...profile, subject: `ps1_${"b".repeat(64)}` },
    }));

    expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]')).toBeNull();
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:retained-avatar");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "The unfinished profile photo was discarded because the signed-in account changed.",
      "error",
      "Profile",
    );
  });

  it("never renders a former subject crop during a direct ready-subject transition", async () => {
    await renderProfile(contextValue());
    await beginCrop();

    await renderProfile(contextValue({
      profile: { ...profile, subject: `ps1_${"b".repeat(64)}` },
    }));

    expect(container.querySelector('[data-testid="profile-modal"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]')).toBeNull();
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("discards an unfinished crop visibly after sign-out resolves", async () => {
    await renderProfile(contextValue());
    await beginCrop();

    await renderProfile(contextValue({ state: "signed-out", profile: null }));

    expect(container.querySelector('[data-testid="profile-modal"]')).toBeNull();
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "The unfinished profile photo was discarded because the session ended.",
      "error",
      "Profile",
    );
  });

  it("does not let a stale crop completion erase a new subject's crop", async () => {
    let resolveProcessing!: () => void;
    mocks.process.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveProcessing = resolve;
      }),
    );
    mocks.createObjectURL
      .mockReturnValueOnce("blob:subject-a")
      .mockReturnValueOnce("blob:subject-b");
    await renderProfile(contextValue());
    await beginCrop();

    const firstSave = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    act(() => firstSave?.click());
    await act(async () => Promise.resolve());

    await renderProfile(contextValue({ state: "loading", profile: null }));
    const subjectB = { ...profile, subject: `ps1_${"b".repeat(64)}` };
    await renderProfile(contextValue({ profile: subjectB }));
    await beginCrop();

    resolveProcessing();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]')?.value).toBe("2");
    expect(container.querySelector('[data-testid="crop-zoom"]')?.textContent).toBe("2");
    const secondSave = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    expect(secondSave?.disabled).toBe(false);
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:subject-a");
    expect(mocks.revokeObjectURL).not.toHaveBeenCalledWith("blob:subject-b");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("keeps submitted ownership stable when processing settles with a subject-change commit", async () => {
    let resolveProcessing!: () => void;
    mocks.process.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveProcessing = resolve;
      }),
    );
    await renderProfile(contextValue());
    await beginCrop();
    const savePhoto = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    act(() => savePhoto?.click());
    await act(async () => Promise.resolve());

    const subjectB = { ...profile, subject: `ps1_${"b".repeat(64)}` };
    act(() => {
      root?.render(
        <ShellProfileContext.Provider value={contextValue({ profile: subjectB })}>
          <ProfileSection onSignOut={vi.fn()} />
        </ShellProfileContext.Provider>,
      );
      resolveProcessing();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="profile-modal"]')).toBeNull();
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:retained-avatar");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("keeps a submitted crop owned until processing settles after unmount", async () => {
    let resolveProcessing!: () => void;
    mocks.process.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveProcessing = resolve;
      }),
    );
    await renderProfile(contextValue());
    await beginCrop();
    const savePhoto = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    act(() => savePhoto?.click());
    await act(async () => Promise.resolve());

    act(() => root?.unmount());
    root = null;
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();

    resolveProcessing();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:retained-avatar");
  });

  it("does not allow a second same-subject submit while a restored crop is processing", async () => {
    let resolveProcessing!: () => void;
    mocks.process.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveProcessing = resolve;
      }),
    );
    await renderProfile(contextValue());
    await beginCrop();
    const firstSave = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    act(() => firstSave?.click());
    await act(async () => Promise.resolve());

    await renderProfile(contextValue({ state: "loading", profile: null }));
    await renderProfile(contextValue());
    const restoredSave = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Saving…",
    );
    expect(restoredSave?.disabled).toBe(true);
    act(() => restoredSave?.click());
    expect(mocks.process).toHaveBeenCalledTimes(1);

    resolveProcessing();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom"]')).toBeNull();
  });
});
