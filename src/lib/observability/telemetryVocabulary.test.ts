import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { AXIS_DYNAMIC_TELEMETRY_BASELINE } from "./telemetryInventory.baseline";
import { collectTelemetryInventory, vocabularyKindForField } from "./telemetryInventory";
import { AXIS_TELEMETRY_VOCABULARY } from "./telemetryVocabulary";

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function telemetryProducerSource(source: string): boolean {
  return /(?:\b(?:captureRouteError|captureException|captureMessage|addBreadcrumb|recordSafeFetchFailures?|recordSafeFetch|providerTiming|timedProviderFetch|timedProviderOperation|logRouteTiming|recordProviderFailure)\s*\(|\bSentry\.(?:captureException|captureMessage|addBreadcrumb)\s*\()/.test(source);
}

function productionInventory() {
  const root = resolve(process.cwd(), "src");
  // Read and parse each source file at most once in this drift target.
  const producers = sourceFiles(root)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))
    .filter(({ source }) => telemetryProducerSource(source));
  const dynamic: string[] = [];
  const knownValues: Array<{ field: "area" | "provider" | "transport" | "via" | "operation" | "op" | "code" | "error_code" | "supabase_code"; value: string }> = [];
  for (const { file, source } of producers) {
    const inventory = collectTelemetryInventory(file, source);
    dynamic.push(...inventory.dynamic.map((entry) => entry.replace(`${process.cwd()}/`, "")));
    knownValues.push(...inventory.knownValues);
  }
  return { producers, dynamic: dynamic.sort(), knownValues };
}

describe("telemetry vocabulary provenance", () => {
  it("pins release and installed SDK versions", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { version: string };
    const sentryPackage = JSON.parse(readFileSync(resolve(process.cwd(), "node_modules/@sentry/nextjs/package.json"), "utf8")) as { version: string };
    expect(packageJson.version).toBe("0.1.0");
    expect(sentryPackage.version).toBe("10.59.0");
  });

  it("contains no duplicate reviewed identifiers", () => {
    for (const values of Object.values(AXIS_TELEMETRY_VOCABULARY)) expect(new Set(values).size).toBe(values.length);
  });

  it("pins every dynamic telemetry metadata occurrence and validates knowable values", () => {
    const inventory = productionInventory();
    expect(inventory.producers.length).toBeGreaterThan(20);
    // Deliberately preserve duplicate occurrences: a removed or added use must be reviewed.
    expect(inventory.dynamic).toEqual([...AXIS_DYNAMIC_TELEMETRY_BASELINE].sort());
    for (const { field, value } of inventory.knownValues) {
      const kind = vocabularyKindForField(field);
      expect(kind, `known telemetry field ${field}`).toBeDefined();
      expect(AXIS_TELEMETRY_VOCABULARY[kind!]).toContain(value as never);
    }
  // This AST-only target completes in under the normal five-second test budget
  // on an otherwise idle Node 24 worker. A larger ceiling avoids unrelated
  // full-suite worker contention turning a deterministic drift check flaky.
  }, 15_000);

  it("detects variables, constants, ternaries, property reads, shorthand, spreads, computed keys, and templates", () => {
    const source = `
      const code = "SAFE_FETCH_TIMEOUT" as const;
      const operation = true ? "list" : "detail";
      const fixed = { area: "mail", code } as const;
      const codes = { primary: "NOT_FOUND", fallback: "SERVICE_UNAVAILABLE" } as const;
      const propertyRead = codes[selector];
      recordProviderFailure(error, {
        tags: {
          ...fixed,
          operation,
          code: propertyRead,
          [dynamicKey]: value,
          provider: \`gmail\`,
        },
      });
    `;
    const inventory = collectTelemetryInventory("fixture.ts", source);
    expect(inventory.dynamic).toEqual([
      "fixture.ts|code|identifier:propertyRead",
      "fixture.ts|code|shorthand:code",
      "fixture.ts|operation|shorthand:operation",
      "fixture.ts|provider|template:`gmail`",
      "fixture.ts|shape|computed:identifier:dynamicKey",
      "fixture.ts|shape|spread:identifier:fixed",
    ]);
    expect(inventory.knownValues).toEqual([
      { field: "area", value: "mail" },
      { field: "code", value: "NOT_FOUND" },
      { field: "code", value: "SAFE_FETCH_TIMEOUT" },
      { field: "code", value: "SERVICE_UNAVAILABLE" },
      { field: "operation", value: "detail" },
      { field: "operation", value: "list" },
      { field: "provider", value: "gmail" },
    ]);
  });

  it("changes the review inventory when a dynamic producer expression changes", () => {
    const original = collectTelemetryInventory("mutation.ts", `Sentry.captureException(error, { tags: { operation } });`);
    const changed = collectTelemetryInventory("mutation.ts", `Sentry.captureException(error, { tags: { operation: source.operation } });`);
    expect(changed.dynamic).not.toEqual(original.dynamic);
    expect(original.dynamic).toEqual(["mutation.ts|operation|shorthand:operation"]);
    expect(changed.dynamic).toEqual(["mutation.ts|operation|property:source.operation"]);
  });
});
