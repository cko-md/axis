import type { EntityKind } from "@/lib/entities/types";

export type EntityServerOperation = "resolve" | "search";
export type EntityServerErrorCode = "NOT_FOUND" | "UNAVAILABLE";

/** Safe to serialize: it intentionally excludes provider messages and query data. */
export type EntityServerError = Readonly<{
  code: EntityServerErrorCode;
  kind: EntityKind;
  operation: EntityServerOperation;
  message: string;
  providerCode?: string;
}>;

function safeProviderCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code ?? "");
  return /^[A-Za-z0-9_-]{1,48}$/.test(code) ? code : undefined;
}

export function entityNotFound(kind: EntityKind): EntityServerError {
  return {
    code: "NOT_FOUND",
    kind,
    operation: "resolve",
    message: "The requested entity was not found.",
  };
}

export function entityUnavailable(
  kind: EntityKind,
  operation: EntityServerOperation,
  error: unknown,
): EntityServerError {
  const providerCode = safeProviderCode(error);
  return {
    code: "UNAVAILABLE",
    kind,
    operation,
    message: "Entity data is temporarily unavailable.",
    ...(providerCode ? { providerCode } : {}),
  };
}
