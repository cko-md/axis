// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

import { RootProviderBoundary } from "./RootProviderBoundary";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.pathname = "/";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("RootProviderBoundary", () => {
  function StrictAuthenticatedTree(): React.ReactElement {
    throw new Error("strict authenticated providers rendered");
  }

  it.each([
    "/",
    "/terms",
    "/terms/",
    "/privacy",
    "/privacy/",
    "/oauth-done",
    "/oauth-done/",
  ])("renders the auth-independent tree for static public path %s", (pathname) => {
    mocks.pathname = pathname;
    act(() => {
      root.render(
        <RootProviderBoundary
          staticPublic={<div data-tree="public" />}
        >
          <div data-tree="authenticated" />
        </RootProviderBoundary>,
      );
    });

    expect(container.querySelector('[data-tree="public"]')).not.toBeNull();
    expect(container.querySelector('[data-tree="authenticated"]')).toBeNull();
  });

  it("does not execute the strict provider subtree for a static public path", () => {
    act(() => {
      root.render(
        <RootProviderBoundary staticPublic={<div data-tree="public" />}>
          <StrictAuthenticatedTree />
        </RootProviderBoundary>,
      );
    });

    expect(container.querySelector('[data-tree="public"]')).not.toBeNull();
  });

  it.each(["/login", "/auth/callback", "/command", "/api/future"])(
    "keeps the strict authenticated provider tree for %s",
    (pathname) => {
      mocks.pathname = pathname;
      act(() => {
        root.render(
          <RootProviderBoundary
            staticPublic={<div data-tree="public" />}
          >
            <div data-tree="authenticated" />
          </RootProviderBoundary>,
        );
      });

      expect(container.querySelector('[data-tree="authenticated"]')).not.toBeNull();
      expect(container.querySelector('[data-tree="public"]')).toBeNull();
    },
  );
});
