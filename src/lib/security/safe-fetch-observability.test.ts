import { describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

import { SafeFetchError } from "./safe-fetch";
import { recordSafeFetchFailure } from "./safe-fetch-observability";

describe("safe-fetch observability", () => {
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
});
