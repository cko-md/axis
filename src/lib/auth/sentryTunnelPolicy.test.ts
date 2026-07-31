import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { wrapMiddlewareWithSentry } from "@sentry/nextjs";
import { describe, expect, it, vi } from "vitest";
import webpack from "webpack";
import nextConfig from "../../../next.config";
import { classifyAccess } from "./accessPolicy";

type Rewrite = { destination?: string; source?: string };
type RewritesResult = Rewrite[] | { beforeFiles?: Rewrite[] };
type RoutePattern = string[];
type WebpackRule = { use?: { options?: { wrappingTargetKind?: string } }[] };
type WebpackConfig = {
  experiments?: Record<string, unknown>;
  externals?: unknown[];
  ignoreWarnings?: unknown[];
  module?: { rules?: WebpackRule[] };
  optimization?: {
    minimizer?: unknown[];
    minimize?: boolean;
    splitChunks?: false | { cacheGroups?: Record<string, unknown> };
  };
  output?: { hashFunction?: string };
  plugins?: unknown[];
  resolve?: { modules?: string[] };
};

const SENTRY_DESTINATIONS = [
  "https://o:orgid.ingest.:region.sentry.io/api/:projectid/envelope/?hsts=0",
  "https://o:orgid.ingest.sentry.io/api/:projectid/envelope/?hsts=0",
];

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const pathname = join(root, entry.name);
    return entry.isDirectory() ? listFiles(pathname) : [pathname];
  });
}

function routePatterns(root: string): RoutePattern[] {
  return listFiles(root)
    .filter((pathname) => /(?:^|[\\/])(?:page|route)\.(?:tsx?|jsx?)$/.test(pathname))
    .map((pathname) => relative(root, pathname).split(sep).slice(0, -1))
    .map((segments) => segments.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")"))));
}

function routeClaimsPath(pattern: RoutePattern, pathname: string): boolean {
  const requested = pathname.split("/").filter(Boolean);
  let patternIndex = 0;
  let requestIndex = 0;
  while (patternIndex < pattern.length) {
    const segment = pattern[patternIndex]!;
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return true;
    if (/^\[\.\.\..+\]$/.test(segment)) return requestIndex < requested.length;
    if (requestIndex >= requested.length) return false;
    if (!/^\[.+\]$/.test(segment) && segment !== requested[requestIndex]) return false;
    patternIndex += 1;
    requestIndex += 1;
  }
  return requestIndex === requested.length;
}

function publicFileClaimsPath(pathname: string): boolean {
  const normalized = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return listFiles("public").some((file) => relative("public", file) === normalized);
}

describe("Sentry tunnel access policy", () => {
  it("evaluates the wrapped config: exact rewrites remain while middleware auto-wrap is disabled", async () => {
    const rewrites = await (nextConfig.rewrites as (() => Promise<RewritesResult>))();
    const rules = Array.isArray(rewrites) ? rewrites : rewrites.beforeFiles ?? [];
    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.source)).toEqual([
      "/monitoring(/?)",
      "/monitoring(/?)",
    ]);
    expect(rules.map((rule) => rule.destination)).toEqual(SENTRY_DESTINATIONS);
    const configured = (nextConfig.webpack as (
      config: WebpackConfig,
      context: {
        dev: boolean;
        dir: string;
        isServer: boolean;
        nextRuntime: string;
        webpack: typeof webpack;
      },
    ) => WebpackConfig)({
      experiments: {},
      externals: [],
      module: { rules: [] },
      optimization: { minimize: false, minimizer: [], splitChunks: false },
      output: {},
      plugins: [],
      resolve: { modules: [] },
    }, {
      dev: true,
      dir: process.cwd(),
      isServer: true,
      nextRuntime: "edge",
      webpack,
    });
    const wrappingTargets = configured.module?.rules?.flatMap((rule) =>
      rule.use?.map((entry) => entry.options?.wrappingTargetKind) ?? [],
    ) ?? [];
    expect(wrappingTargets).toEqual(expect.arrayContaining([
      "api-route",
      "page",
      "server-component",
    ]));
    expect(wrappingTargets).not.toContain("middleware");
    expect(classifyAccess("/monitoring")).toBe("telemetry-ingest");
    expect(classifyAccess("/monitoring/")).toBe("telemetry-ingest");
    expect(classifyAccess("/monitoring/extra")).toBe("authenticated");
    expect(classifyAccess("/monitoring-lookalike")).toBe("authenticated");
  });

  it("proves why the installed SDK middleware wrapper is unsafe when auto-wrapping is enabled", async () => {
    const globalWithTunnel = globalThis as typeof globalThis & { _sentryRewritesTunnelPath?: unknown };
    const previousTunnelPath = globalWithTunnel._sentryRewritesTunnelPath;
    globalWithTunnel._sentryRewritesTunnelPath = "/monitoring";
    const invoked = vi.fn(() => new Response(null, { status: 204 }));
    const wrapped = wrapMiddlewareWithSentry(invoked as never) as unknown as (request: Request) => Promise<Response>;

    try {
      expect((await wrapped(new Request("https://axis.test/monitoring"))).status).toBe(200);
      expect((await wrapped(new Request("https://axis.test/monitoring/extra"))).status).toBe(200);
      expect((await wrapped(new Request("https://axis.test/monitoring-lookalike"))).status).toBe(204);
      expect(invoked).toHaveBeenCalledTimes(1);
    } finally {
      if (previousTunnelPath === undefined) delete globalWithTunnel._sentryRewritesTunnelPath;
      else globalWithTunnel._sentryRewritesTunnelPath = previousTunnelPath;
    }
  });

  it("keeps the tunnel namespace unclaimed by materialized application mappings", async () => {
    const routeInventory = [...routePatterns("src/app"), ...routePatterns("pages")];
    const rewrites = await (nextConfig.rewrites as (() => Promise<RewritesResult>))();
    const rewriteRules = Array.isArray(rewrites) ? rewrites : rewrites.beforeFiles ?? [];
    const redirects = await (nextConfig.redirects as (() => Promise<{ source: string }[]>) )();
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path?: string }[] };

    for (const pathname of ["/monitoring", "/monitoring/extra"]) {
      expect(routeInventory.some((pattern) => routeClaimsPath(pattern, pathname))).toBe(false);
      expect(publicFileClaimsPath(pathname)).toBe(false);
      expect(redirects.some((redirect) => routeClaimsPath(redirect.source.split("/").filter(Boolean), pathname))).toBe(false);
      expect(vercel.crons?.some((cron) => cron.path === pathname)).not.toBe(true);
    }
    expect(rewriteRules).toHaveLength(2);
    expect(rewriteRules.every((rule) => rule.source === "/monitoring(/?)" && SENTRY_DESTINATIONS.includes(rule.destination ?? ""))).toBe(true);
  });
});
