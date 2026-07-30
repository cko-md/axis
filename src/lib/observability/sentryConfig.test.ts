import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("Sentry runtime scrub hooks", () => {
  it.each(["sentry.server.config.ts", "sentry.edge.config.ts", "instrumentation-client.ts"])("wires transaction, span, and breadcrumb scrubbing in %s", async (file) => {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    expect(source).toMatch(/beforeSend:\s*scrubSentryEventStrict/);
    expect(source).toMatch(/beforeSendTransaction:\s*scrubSentryTransaction/);
    expect(source).toMatch(/beforeSendSpan:\s*scrubSentrySpan/);
    expect(source).toMatch(/beforeBreadcrumb:\s*scrubSentryBreadcrumb/);
  });

  it("keeps Replay fully disabled until every rrweb event type is scrubbed", async () => {
    const source = await readFile(path.join(process.cwd(), "instrumentation-client.ts"), "utf8");
    expect(source).not.toContain("replayIntegration(");
    expect(source).toMatch(/replaysOnErrorSampleRate:\s*0\b/);
    expect(source).toMatch(/replaysSessionSampleRate:\s*0\b/);
  });
});
