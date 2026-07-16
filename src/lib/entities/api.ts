import { z } from "zod";
import { isEntityKind, normalizeEntityRef } from "@/lib/entities/registry";
import {
  ENTITY_KINDS,
  ENTITY_RELATIONS,
  ENTITY_USAGE_ACTIONS,
  type EntityKind,
  type EntityRef,
} from "@/lib/entities/types";

export const ENTITY_SEARCH_MIN_QUERY = 2;
export const ENTITY_SEARCH_MAX_QUERY = 120;
export const ENTITY_SEARCH_MAX_RESULTS = 25;

const entityKindSchema = z.enum(ENTITY_KINDS);

export const entityRefSchema = z
  .object({
    kind: entityKindSchema,
    id: z.string().min(1).max(256),
  })
  .strict()
  .transform((ref, context): EntityRef => {
    const normalized = normalizeEntityRef(ref);
    if (!normalized) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid entity reference" });
      return z.NEVER;
    }
    return normalized;
  });

export const createEntityReferenceSchema = z
  .object({
    source: entityRefSchema,
    target: entityRefSchema,
    relation: z.enum(ENTITY_RELATIONS).default("related"),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source.kind === value.target.kind && value.source.id === value.target.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "An entity cannot reference itself",
      });
    }
  });

export const recordEntityUsageSchema = z
  .object({ action: z.enum(ENTITY_USAGE_ACTIONS) })
  .strict();

export function parseEntityPath(kind: string, id: string): EntityRef | null {
  if (!isEntityKind(kind)) return null;
  return normalizeEntityRef({ kind, id });
}

export type ParsedEntitySearchQuery = Readonly<{
  query: string;
  kinds: readonly EntityKind[];
  limit: number;
}>;

export function parseEntitySearchQuery(params: URLSearchParams): ParsedEntitySearchQuery | null {
  const query = params.get("q")?.trim() ?? "";
  if (query.length < ENTITY_SEARCH_MIN_QUERY || query.length > ENTITY_SEARCH_MAX_QUERY) return null;

  const rawKinds = params.get("types")
    ?.split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  if (rawKinds?.some((kind) => !isEntityKind(kind))) return null;
  const kinds = rawKinds?.length ? [...new Set(rawKinds as EntityKind[])] : [...ENTITY_KINDS];

  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 15 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > ENTITY_SEARCH_MAX_RESULTS) return null;
  return { query, kinds, limit };
}
