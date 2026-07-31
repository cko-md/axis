import ts from "typescript";

/**
 * Fields which can survive AXIS's strict Sentry boundary.  We inventory only
 * object literals that are passed to a telemetry producer (or values reached
 * through a const used by one), rather than every object in a producer file.
 */
const VOCABULARY_FIELDS = {
  area: "areas",
  provider: "providers",
  transport: "transports",
  via: "transports",
  operation: "operations",
  op: "operations",
  code: "codes",
  error_code: "codes",
  supabase_code: "codes",
} as const;

const METADATA_FIELDS = new Set([
  ...Object.keys(VOCABULARY_FIELDS),
  "status", "http_status", "status_code", "http.status_code", "outcome",
  "durationMs", "delayMs", "attempt", "attempted", "disconnected", "failed",
  "queryLength", "encoded_length", "request_body_size", "response_body_size",
  "retryable", "partial", "fallback", "sampled", "is_segment", "handled",
  "synthetic", "is_exception_group", "http.route", "route", "category", "level", "type",
]);

export type TelemetryVocabularyKind = typeof VOCABULARY_FIELDS[keyof typeof VOCABULARY_FIELDS];

export type TelemetryInventory = {
  /** One entry per occurrence. Duplicates are intentional and reviewable. */
  dynamic: string[];
  /** Statically knowable strings used by a vocabulary-backed field. */
  knownValues: Array<{ field: keyof typeof VOCABULARY_FIELDS; value: string }>;
};

function propertyKey(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    const expression = node.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  }
  return undefined;
}

function expressionText(node: ts.Expression, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, " ").trim();
}

function expressionShape(node: ts.Expression, source: ts.SourceFile): string {
  if (ts.isIdentifier(node)) return `identifier:${node.text}`;
  if (ts.isPropertyAccessExpression(node)) return `property:${expressionText(node, source)}`;
  if (ts.isElementAccessExpression(node)) return `element:${expressionText(node, source)}`;
  if (ts.isConditionalExpression(node)) return `ternary:${expressionText(node, source)}`;
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return `template:${expressionText(node, source)}`;
  return `expression:${expressionText(node, source)}`;
}

function isTelemetryProducer(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return new Set([
      "captureRouteError", "captureException", "captureMessage", "addBreadcrumb",
      "recordSafeFetchFailure", "recordSafeFetchFailures", "recordSafeFetch", "providerTiming",
      "timedProviderFetch", "timedProviderOperation", "logRouteTiming", "recordProviderFailure",
    ]).has(expression.text);
  }
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const owner = expression.expression;
  return ts.isIdentifier(owner) && owner.text === "Sentry"
    && new Set(["captureException", "captureMessage", "addBreadcrumb"]).has(expression.name.text);
}

function variableInitializers(source: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return initializers;
}

function staticStrings(
  expression: ts.Expression,
  source: ts.SourceFile,
  variables: ReadonlyMap<string, ts.Expression>,
  seen = new Set<ts.Node>(),
): string[] {
  if (seen.has(expression)) return [];
  seen.add(expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    return [...staticStrings(expression.whenTrue, source, variables, seen), ...staticStrings(expression.whenFalse, source, variables, seen)];
  }
  if (ts.isIdentifier(expression)) {
    const initializer = variables.get(expression.text);
    return initializer ? staticStrings(initializer, source, variables, seen) : [];
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return staticStrings(expression.expression, source, variables, seen);
  }
  if (ts.isElementAccessExpression(expression) || ts.isPropertyAccessExpression(expression)) {
    const target = expression.expression;
    if (ts.isIdentifier(target)) {
      let initializer = variables.get(target.text);
      while (initializer && (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        const values: string[] = [];
        for (const property of initializer.properties) {
          if (ts.isPropertyAssignment(property)) values.push(...staticStrings(property.initializer, source, variables, seen));
        }
        return values;
      }
    }
  }
  return [];
}

/**
 * Collect the reviewable dynamic telemetry contract from one parsed source
 * file. The caller should invoke this once per file; the collector itself does
 * not read the filesystem and consequently cannot hide a second parse.
 */
export function collectTelemetryInventory(file: string, sourceText: string): TelemetryInventory {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const variables = variableInitializers(source);
  const dynamic: string[] = [];
  const knownValues: Array<{ field: keyof typeof VOCABULARY_FIELDS; value: string }> = [];
  const visitedExpressions = new Set<ts.Node>();

  const inspectExpression = (expression: ts.Expression, ancestry = new Set<ts.Node>()) => {
    if (ancestry.has(expression)) return;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
      inspectExpression(expression.expression, nextAncestry);
      return;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = variables.get(expression.text);
      if (initializer) inspectExpression(initializer, nextAncestry);
      return;
    }
    if (!ts.isObjectLiteralExpression(expression)) return;
    if (visitedExpressions.has(expression)) return;
    visitedExpressions.add(expression);

    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        dynamic.push(`${file}|shape|spread:${expressionShape(property.expression, source)}`);
        inspectExpression(property.expression, nextAncestry);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (METADATA_FIELDS.has(property.name.text)) {
          dynamic.push(`${file}|${property.name.text}|shorthand:${property.name.text}`);
          const initializer = variables.get(property.name.text);
          if (initializer && property.name.text in VOCABULARY_FIELDS) {
            for (const value of staticStrings(initializer, source, variables)) {
              knownValues.push({ field: property.name.text as keyof typeof VOCABULARY_FIELDS, value });
            }
          }
        }
        // `{ tags }` and `{ data }` are also common Sentry option forms.
        // Follow their local constant initializer so nested metadata cannot
        // evade the review baseline merely by using shorthand syntax.
        const initializer = variables.get(property.name.text);
        if (initializer) inspectExpression(initializer, nextAncestry);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      if (ts.isComputedPropertyName(property.name)) {
        dynamic.push(`${file}|shape|computed:${expressionShape(property.name.expression, source)}`);
      }
      const key = propertyKey(property.name);
      if (key && METADATA_FIELDS.has(key)) {
        const literal = ts.isStringLiteral(property.initializer) || ts.isNumericLiteral(property.initializer);
        if (!literal) dynamic.push(`${file}|${key}|${expressionShape(property.initializer, source)}`);
        if (key in VOCABULARY_FIELDS) {
          for (const value of staticStrings(property.initializer, source, variables)) {
            knownValues.push({ field: key as keyof typeof VOCABULARY_FIELDS, value });
          }
        }
      }
      inspectExpression(property.initializer, nextAncestry);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTelemetryProducer(node)) {
      for (const argument of node.arguments) inspectExpression(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { dynamic: dynamic.sort(), knownValues: knownValues.sort((a, b) => `${a.field}\0${a.value}`.localeCompare(`${b.field}\0${b.value}`)) };
}

/** Backwards-compatible narrow view for callers that only need inventory rows. */
export function collectDynamicTelemetryExpressions(file: string, source: string): string[] {
  return collectTelemetryInventory(file, source).dynamic;
}

export function vocabularyKindForField(field: string): TelemetryVocabularyKind | undefined {
  return VOCABULARY_FIELDS[field as keyof typeof VOCABULARY_FIELDS];
}
