/**
 * Canonical entity contracts for the Axis workspace.
 *
 * The reference is intentionally tiny and provider-neutral: modules may keep
 * their richer domain models, while search, previews, links, commands, and the
 * workspace shell can exchange one stable identity shape.
 */

export const ENTITY_KINDS = [
  "note",
  "task",
  "agenda_task",
  "person",
  "signal",
  "approval",
  "routine_run",
  "account",
  "holding",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EntityRef = Readonly<{
  kind: EntityKind;
  id: string;
}>;

export type EntityMetaItem = Readonly<{
  label: string;
  value: string;
}>;

export type EntitySummary = Readonly<{
  ref: EntityRef;
  title: string;
  subtitle?: string;
  description?: string;
  href: string;
  status?: string;
  updatedAt?: string;
  meta: readonly EntityMetaItem[];
}>;

export type EntityUsage = Readonly<{
  useCount: number;
  lastUsedAt: string | null;
  lastAction: EntityUsageAction | null;
}>;

export const ENTITY_USAGE_ACTIONS = ["direct", "search", "command", "link"] as const;
export type EntityUsageAction = (typeof ENTITY_USAGE_ACTIONS)[number];

export type EntityRanking = Readonly<{
  text: number;
  usage: number;
  freshness: number;
  total: number;
  reasons: readonly string[];
}>;

export type EntitySearchResult = EntitySummary & Readonly<{
  ranking: EntityRanking;
}>;

export type EntitySearchSource = Readonly<{
  kind: EntityKind | "usage";
  status: "ok" | "unavailable";
  count: number;
  code?: string;
}>;

export type EntitySearchResponse = Readonly<{
  version: 1;
  results: readonly EntitySearchResult[];
  sources: readonly EntitySearchSource[];
  partial: boolean;
}>;

export const ENTITY_RELATIONS = ["related", "supports", "blocks", "mentions"] as const;
export type EntityRelation = (typeof ENTITY_RELATIONS)[number];

export type EntityReference = Readonly<{
  id: string;
  source: EntityRef;
  target: EntityRef;
  relation: EntityRelation;
  label?: string;
  origin: "user" | "system";
  createdAt: string;
}>;

export type ResolvedEntityReference = EntityReference & Readonly<{
  entity: EntitySummary;
  direction: "outgoing" | "backlink";
}>;

export type EntityPreviewPayload = Readonly<{
  entity: EntitySummary;
  outgoing: readonly ResolvedEntityReference[];
  backlinks: readonly ResolvedEntityReference[];
  referencesStatus: "ok" | "unavailable";
}>;
