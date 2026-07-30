// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), toast: vi.fn(), fetch: vi.fn(), profileName: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.capture }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("react-easy-crop", () => ({ default: () => null }));
vi.mock("@/components/ui/Modal", () => ({ Modal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./cropImage", () => ({ getCroppedImageBlob: vi.fn() }));
import { ProfileSection } from "./ProfileSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const good = { display_name: "Name", role_title: "Role", bio: null, avatar_url: null, email: "account@example.test" };

beforeEach(() => { mocks.capture.mockReset(); mocks.toast.mockReset(); mocks.fetch.mockReset(); mocks.profileName.mockReset(); vi.stubGlobal("fetch", mocks.fetch); vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)); vi.stubGlobal("cancelAnimationFrame", clearTimeout); const element = document.createElement("div"); document.body.append(element); root = createRoot(element); });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("ProfileSection route-remount identity read", () => {
  it("hydrates a valid same-origin profile", async () => { mocks.fetch.mockResolvedValueOnce({ status: 200, ok: true, json: vi.fn().mockResolvedValue(good) }); act(() => root?.render(<ProfileSection onSignOut={vi.fn()} onProfileName={mocks.profileName} />)); await act(flush); expect(mocks.fetch).toHaveBeenCalledWith("/api/auth/profile", expect.objectContaining({ signal: expect.any(AbortSignal) })); expect(mocks.profileName).toHaveBeenCalledWith("Name"); });
  it("treats 401 as signed out without Sentry or toast", async () => { mocks.fetch.mockResolvedValueOnce({ status: 401, ok: false }); act(() => root?.render(<ProfileSection onSignOut={vi.fn()} />)); await act(flush); expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled(); });
  it("reports malformed and live network failures", async () => { mocks.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")); act(() => root?.render(<ProfileSection onSignOut={vi.fn()} />)); await act(flush); expect(mocks.capture).toHaveBeenCalled(); expect(mocks.toast).toHaveBeenCalledWith("Could not verify the current account", "error", "Profile"); });
  it("aborts a pending identity read on unmount without feedback", async () => { let reject!: (value: unknown) => void; mocks.fetch.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })); act(() => root?.render(<ProfileSection onSignOut={vi.fn()} />)); const init = mocks.fetch.mock.calls[0]?.[1] as RequestInit; act(() => root?.unmount()); root = null; expect(init.signal?.aborted).toBe(true); reject(new DOMException("aborted", "AbortError")); await act(flush); expect(mocks.capture).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled(); });
});
