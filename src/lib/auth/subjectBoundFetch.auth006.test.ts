// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";

const SUBJECT = `ps1_${"a".repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subjectBoundFetch AUTH-006 boundary", () => {
  it("adds the opaque expected subject to a same-origin no-store request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await subjectBoundFetch(SUBJECT, "/api/spotify/playback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/api/spotify/playback");
    expect(new Headers(init.headers).get(EXPECTED_PROFILE_SUBJECT_HEADER)).toBe(SUBJECT);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
  });

  it("rejects missing authority and cross-origin destinations before fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => subjectBoundFetch("invalid", "/api/spotify/token")).toThrow(
      "SUBJECT_BOUND_FETCH_REQUIRES_AUTHORITY",
    );
    expect(() => subjectBoundFetch(SUBJECT, "https://example.com/private")).toThrow(
      "SUBJECT_BOUND_FETCH_REQUIRES_SAME_ORIGIN",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
