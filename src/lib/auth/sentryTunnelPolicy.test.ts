import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { classifyAccess } from "./accessPolicy";

type Rewrite = { destination?: string; source?: string };
type RewritesResult = Rewrite[] | { beforeFiles?: Rewrite[] };

describe("Sentry tunnel access policy", () => {
  it("evaluates the fully wrapped config and permits only its exact tunnel forms", async () => {
    const rewrites = await (nextConfig.rewrites as (() => Promise<RewritesResult>))();
    const rules = Array.isArray(rewrites) ? rewrites : rewrites.beforeFiles ?? [];
    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.source)).toEqual([
      "/monitoring(/?)",
      "/monitoring(/?)",
    ]);
    expect(rules.map((rule) => rule.destination)).toEqual([
      "https://o:orgid.ingest.:region.sentry.io/api/:projectid/envelope/?hsts=0",
      "https://o:orgid.ingest.sentry.io/api/:projectid/envelope/?hsts=0",
    ]);
    expect(classifyAccess("/monitoring")).toBe("telemetry-ingest");
    expect(classifyAccess("/monitoring/")).toBe("telemetry-ingest");
    expect(classifyAccess("/monitoring/extra")).toBe("authenticated");
    expect(classifyAccess("/monitoring-lookalike")).toBe("authenticated");
  });
});
