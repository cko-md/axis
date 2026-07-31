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
    const sentryCorePackage = JSON.parse(readFileSync(resolve(process.cwd(), "node_modules/@sentry/core/package.json"), "utf8")) as { version: string };
    expect(packageJson.version).toBe("0.1.0");
    expect(sentryPackage.version).toBe("10.59.0");
    expect(sentryCorePackage.version).toBe("10.59.0");
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

  it("resolves same-name locals in their lexical scope and pins the first call independently", () => {
    const source = `
      function first() {
        const operation = "SECRET_UNREGISTERED";
        Sentry.captureException(error, { tags: { operation } });
      }
      function second() {
        const operation = "list";
        Sentry.captureException(error, { tags: { operation } });
      }
    `;
    const changedSource = source.replace("SECRET_UNREGISTERED", "CHANGED_UNREGISTERED");
    const original = collectTelemetryInventory("lexical.ts", source);
    const changed = collectTelemetryInventory("lexical.ts", changedSource);
    expect(original.dynamic).toEqual([
      "lexical.ts|operation|shorthand:operation",
      "lexical.ts|operation|shorthand:operation",
    ]);
    expect(new Set(original.knownValues.map(({ value }) => value))).toEqual(
      new Set(["SECRET_UNREGISTERED", "list"]),
    );
    expect(new Set(changed.knownValues.map(({ value }) => value))).toEqual(
      new Set(["CHANGED_UNREGISTERED", "list"]),
    );
    expect(original.knownValues).toHaveLength(2);
    expect(changed.knownValues).toHaveLength(2);
    expect(changed.knownValues).not.toEqual(original.knownValues);
  });

  it("treats for-of and for-in bindings without initializers as shadow barriers", () => {
    const inventory = collectTelemetryInventory("loops.ts", `
      const operation = "root";
      for (const operation of ["loop"]) {
        Sentry.captureException(error, { tags: { operation } });
      }
      for (const operation in { loop: true }) {
        Sentry.captureException(error, { tags: { operation } });
      }
    `);
    expect(inventory.dynamic).toEqual([
      "loops.ts|operation|shorthand:operation",
      "loops.ts|operation|shorthand:operation",
    ]);
    expect(inventory.knownValues).toEqual([]);
  });

  it("does not fall through parameters, catch bindings, or destructuring to an outer constant", () => {
    const inventory = collectTelemetryInventory("bindings.ts", `
      const operation = "root";
      function fromParameter(operation: string) {
        Sentry.captureException(error, { tags: { operation } });
      }
      try {
        throw new Error();
      } catch (operation) {
        Sentry.captureException(error, { tags: { operation } });
      }
      function fromDestructuring(input: { operation: string }) {
        const { operation } = input;
        Sentry.captureException(error, { tags: { operation } });
      }
    `);
    expect(inventory.dynamic).toHaveLength(3);
    expect(inventory.knownValues).toEqual([]);
  });

  it("honors block, var, ordinary-for, declaration-order, sibling, and nested scopes", () => {
    const inventory = collectTelemetryInventory("scope-matrix.ts", `
      const operation = "root";
      {
        Sentry.captureException(error, { tags: { operation } });
        let operation = "block";
        Sentry.captureException(error, { tags: { operation } });
      }
      function withVar() {
        Sentry.captureException(error, { tags: { operation } });
        {
          var operation = "local";
        }
        Sentry.captureException(error, { tags: { operation } });
      }
      for (let operation = "loop"; condition; ) {
        Sentry.captureException(error, { tags: { operation } });
      }
      {
        const operation = "sibling";
        {
          const operation = "nested";
          Sentry.captureException(error, { tags: { operation } });
        }
        Sentry.captureException(error, { tags: { operation } });
      }
      {
        Sentry.captureException(error, { tags: { operation } });
      }
    `);
    expect(inventory.dynamic).toHaveLength(8);
    expect(new Set(inventory.knownValues.map(({ value }) => value))).toEqual(
      new Set(["block", "local", "loop", "nested", "root", "sibling"]),
    );
    expect(inventory.knownValues).toHaveLength(6);
  });

  it("treats import, function, class, and destructured declarations as unresolved shadow barriers", () => {
    const imported = collectTelemetryInventory("import.ts", `
      import { operation } from "./provider";
      Sentry.captureException(error, { tags: { operation } });
    `);
    const declared = collectTelemetryInventory("declarations.ts", `
      const operation = "root";
      {
        function operation() {}
        Sentry.captureException(error, { tags: { operation } });
      }
      {
        class operation {}
        Sentry.captureException(error, { tags: { operation } });
      }
      {
        const [operation] = values;
        Sentry.captureException(error, { tags: { operation } });
      }
    `);
    expect(imported.dynamic).toHaveLength(1);
    expect(imported.knownValues).toEqual([]);
    expect(declared.dynamic).toHaveLength(3);
    expect(declared.knownValues).toEqual([]);
  });
});
