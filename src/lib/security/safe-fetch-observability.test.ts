import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

import { SafeFetchError } from "./safe-fetch";
import { recordSafeFetchFailure, recordSafeFetchFailures } from "./safe-fetch-observability";

describe("safe-fetch observability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("omits raw host, IP, path, and query canaries", () => {
    recordSafeFetchFailure(
      "og_image_meta",
      "http://[::ffff:127.0.0.1]/canary?token=must-not-leak",
      new SafeFetchError("SAFE_FETCH_BLOCKED_ADDRESS"),
    );

    const breadcrumb = sentry.addBreadcrumb.mock.calls[0]?.[0];
    expect(breadcrumb).toMatchObject({
      category: "safe-fetch",
      data: { operation: "og_image_meta", code: "SAFE_FETCH_BLOCKED_ADDRESS" },
    });
    const serialized = JSON.stringify(breadcrumb);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("7f00");
    expect(serialized).not.toContain("canary");
    expect(serialized).not.toContain("must-not-leak");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("retains only an allowlisted coarse provider class", () => {
    recordSafeFetchFailure(
      "youtube_caption",
      "https://www.youtube.com/api/timedtext?signature=must-not-leak",
      new SafeFetchError("SAFE_FETCH_TIMEOUT"),
    );
    const serialized = JSON.stringify(sentry.addBreadcrumb.mock.calls.at(-1)?.[0]);
    expect(serialized).toContain('"provider":"youtube"');
    expect(serialized).not.toContain("www.youtube.com");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("must-not-leak");
  });

  it.each(["SAFE_FETCH_DNS_FAILED", "SAFE_FETCH_TIMEOUT", "SAFE_FETCH_TRANSPORT_FAILED"] as const)("creates a sanitized searchable event for %s", (code) => {
    recordSafeFetchFailure("reader_extract", "https://www.youtube.com/watch?private=must-not-leak", new SafeFetchError(code));
    const event = sentry.captureException.mock.calls.at(-1);
    expect(event?.[0]).toMatchObject({ message: code });
    expect(event?.[1]).toMatchObject({ tags: { area: "safe-fetch", operation: "reader_extract", code, provider: "youtube" } });
    expect(JSON.stringify(event)).not.toContain("www.youtube.com");
    expect(JSON.stringify(event)).not.toContain("private");
    expect(JSON.stringify(event)).not.toContain("must-not-leak");
  });

  it("keeps policy refusals as breadcrumbs only", () => {
    recordSafeFetchFailure("reader_extract", "http://127.0.0.1/canary?private=must-not-leak", new SafeFetchError("SAFE_FETCH_BLOCKED_ADDRESS"));
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("coalesces a batch into one searchable event while returning one code per source", () => {
    const results = recordSafeFetchFailures("cached_feed", Array.from({ length: 6 }, (_, index) => ({
      rawTarget: `https://feed-${index}.example/private?token=must-not-leak`,
      error: new SafeFetchError("SAFE_FETCH_TIMEOUT"),
    })));
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.code === "SAFE_FETCH_TIMEOUT")).toBe(true);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain("feed-0.example");
    expect(JSON.stringify(sentry.captureException.mock.calls)).not.toContain("must-not-leak");
  });
});
