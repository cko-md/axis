import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { filterAxisErrorOnlyIntegrations } from "./sentryErrorOnlyConfig";

const CONFIGS = ["sentry.server.config.ts", "sentry.edge.config.ts", "instrumentation-client.ts"] as const;

type ProductionSource = { file: string; text: string };

function canContainSentryRegistration(text: string): boolean {
  return text.includes("Sentry")
    || text.includes("beforeEnvelope")
    || text.includes("addIntegration");
}

async function productionTypeScriptSources(): Promise<ProductionSource[]> {
  const files = CONFIGS.map((file) => path.join(process.cwd(), file));
  const walk = async (directory: string): Promise<void> => {
    await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (
        entry.isFile()
        && /\.(?:ts|tsx)$/.test(entry.name)
        && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
      ) files.push(target);
    }));
  };
  await walk(path.join(process.cwd(), "src"));
  return Promise.all(files.sort().map(async (file) => ({
    file,
    text: await readFile(file, "utf8"),
  })));
}

describe("Sentry error-only runtime configuration", () => {
  it.each(CONFIGS)("wires one terminal finalizer and disables every non-error channel in %s", async (file) => {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    expect(source).toMatch(/beforeSend:\s*guardedSentryEvent/);
    expect(source).toMatch(/beforeSendTransaction:\s*guardedSentryTransaction/);
    expect(source).toMatch(/beforeBreadcrumb:\s*guardedSentryBreadcrumb/);
    expect(source).not.toContain("beforeSendSpan");
    expect(source).toMatch(/tracesSampleRate:\s*0\b/);
    expect(source).toMatch(/sendClientReports:\s*false/);
    expect(source).toMatch(/enableLogs:\s*false/);
    expect(source).toMatch(/enableMetrics:\s*false/);
    expect(source).toMatch(/integrations:\s*filterAxisErrorOnlyIntegrations/);
    expect(source.match(/\.on\(\s*["']beforeEnvelope["']/g)).toHaveLength(1);
    expect(source).not.toContain("Sentry.addIntegration");
  });

  it("keeps Replay disabled and exports a local no-op router hook without Sentry tracing", async () => {
    const source = await readFile(path.join(process.cwd(), "instrumentation-client.ts"), "utf8");
    expect(source).not.toContain("replayIntegration(");
    expect(source).toMatch(/replaysOnErrorSampleRate:\s*0\b/);
    expect(source).toMatch(/replaysSessionSampleRate:\s*0\b/);
    expect(source).toContain("export function onRouterTransitionStart");
    expect(source).not.toContain("captureRouterTransitionStart");
  });

  it.each([
    ["instrumentation-client.ts", true],
    ["sentry.server.config.ts", false],
    ["sentry.edge.config.ts", false],
  ] as const)("pins the exact tunnel-header mode in %s", async (file, expectTunnel) => {
    const source = (await readFile(path.join(process.cwd(), file), "utf8")).replace(/\s+/g, " ");
    expect(source).toContain(
      `makeAxisErrorOnlyEnvelopeFinalizer(process.env.NEXT_PUBLIC_SENTRY_DSN, ${expectTunnel})`,
    );
  });

  it("filters tracing, metrics, streamed spans, and browser/process sessions", () => {
    const names = [
      "BrowserTracing", "WebVitals", "SpanStreaming", "FetchStreamPerformance",
      "BrowserSession", "ProcessSession", "InboundFilters",
    ];
    const filtered = filterAxisErrorOnlyIntegrations(names.map((name) => ({ name })) as never);
    expect(filtered.map((integration) => integration.name)).toEqual(["InboundFilters"]);
  });

  it("documents post-deploy queries using surviving error tags rather than dropped transactions", async () => {
    const source = await readFile(path.join(process.cwd(), "docs/observability/sentry.md"), "utf8");
    expect(source).not.toMatch(/transaction:\s*["']/);
    expect(source).toContain('route:"/api/mail/message/[id]/action" operation:archive');
  });

  it.each([
    ["Sentry.init({});"],
    ['client.on("beforeEnvelope", finalize);'],
    ["client.addIntegration(integration);"],
  ])("retains the recursive audit candidate shape %s", (source) => {
    expect(canContainSentryRegistration(source)).toBe(true);
  });

  it("has no later dynamic integration or terminal-finalizer registration outside startup configs", async () => {
    const initFiles: string[] = [];
    const beforeEnvelopeFiles: string[] = [];
    const addIntegrationFiles: string[] = [];
    const sources = await productionTypeScriptSources();
    const candidates = sources.filter(({ text }) => canContainSentryRegistration(text));
    for (const { file, text } of candidates) {
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const { expression, name } = node.expression;
          if (ts.isIdentifier(expression) && expression.text === "Sentry" && name.text === "init") {
            initFiles.push(path.relative(process.cwd(), file));
          }
          if (name.text === "addIntegration") addIntegrationFiles.push(path.relative(process.cwd(), file));
          if (
            name.text === "on"
            && node.arguments.length > 0
            && ts.isStringLiteral(node.arguments[0])
            && node.arguments[0].text === "beforeEnvelope"
          ) beforeEnvelopeFiles.push(path.relative(process.cwd(), file));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(initFiles.sort()).toEqual([...CONFIGS].sort());
    expect(beforeEnvelopeFiles.sort()).toEqual([...CONFIGS].sort());
    expect(addIntegrationFiles).toEqual([]);
  });
});
