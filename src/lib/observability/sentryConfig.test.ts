import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("Sentry runtime scrub hooks", () => {
  it.each(["sentry.server.config.ts", "sentry.edge.config.ts", "instrumentation-client.ts"])("wires transaction, span, and breadcrumb scrubbing in %s", async (file) => {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    expect(source).toMatch(/beforeSendTransaction:\s*scrubSentryTransaction/);
    expect(source).toMatch(/beforeSendSpan:\s*scrubSentrySpan/);
    expect(source).toMatch(/beforeBreadcrumb:\s*scrubSentryBreadcrumb/);
  });

  it("disables Replay network details, bodies, and headers", async () => {
    const source = await readFile(path.join(process.cwd(), "instrumentation-client.ts"), "utf8");
    expect(source).toMatch(/networkDetailAllowUrls:\s*\[\]/);
    expect(source).toMatch(/networkDetailDenyUrls:\s*\[\/\.\*\/\]/);
    expect(source).toMatch(/networkCaptureBodies:\s*false/);
    expect(source).toMatch(/networkRequestHeaders:\s*\[\]/);
    expect(source).toMatch(/networkResponseHeaders:\s*\[\]/);
    expect(source).toMatch(/beforeAddRecordingEvent:\s*scrubReplayRecordingEvent/);
  });
});
