import { ENTITY_KINDS, type EntityKind, type EntityRef } from "@/lib/entities/types";

export type EntityDescriptor = Readonly<{
  kind: EntityKind;
  label: string;
  pluralLabel: string;
  icon: string;
  route: string;
  queryKey: string;
  searchable: boolean;
}>;

export const ENTITY_REGISTRY: Readonly<Record<EntityKind, EntityDescriptor>> = {
  note: {
    kind: "note",
    label: "Note",
    pluralLabel: "Notes",
    icon: "notes",
    route: "/notes",
    queryKey: "note",
    searchable: true,
  },
  task: {
    kind: "task",
    label: "Task",
    pluralLabel: "Tasks",
    icon: "tasks",
    route: "/tasks",
    queryKey: "task",
    searchable: true,
  },
  agenda_task: {
    kind: "agenda_task",
    label: "Agenda task",
    pluralLabel: "Agenda tasks",
    icon: "agenda",
    route: "/agenda",
    queryKey: "task",
    searchable: true,
  },
  person: {
    kind: "person",
    label: "Person",
    pluralLabel: "People",
    icon: "people",
    route: "/people",
    queryKey: "person",
    searchable: true,
  },
  signal: {
    kind: "signal",
    label: "Signal",
    pluralLabel: "Signals",
    icon: "dispatch",
    route: "/dispatch",
    queryKey: "signal",
    searchable: true,
  },
  approval: {
    kind: "approval",
    label: "Approval",
    pluralLabel: "Approvals",
    icon: "shield",
    route: "/approvals",
    queryKey: "approval",
    searchable: true,
  },
  routine_run: {
    kind: "routine_run",
    label: "Routine run",
    pluralLabel: "Routine runs",
    icon: "tasks",
    route: "/tasks",
    queryKey: "run",
    searchable: true,
  },
  account: {
    kind: "account",
    label: "Account",
    pluralLabel: "Accounts",
    icon: "fund",
    route: "/control-room",
    queryKey: "account",
    searchable: true,
  },
  holding: {
    kind: "holding",
    label: "Holding",
    pluralLabel: "Holdings",
    icon: "fund",
    route: "/fund/investing",
    queryKey: "holding",
    searchable: true,
  },
};

const ENTITY_KIND_SET: ReadonlySet<string> = new Set(ENTITY_KINDS);
const MAX_ENTITY_ID_LENGTH = 256;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOLDING_ID = /^[A-Z0-9.-]{1,32}$/;

export function isEntityKind(value: string): value is EntityKind {
  return ENTITY_KIND_SET.has(value);
}

export function isEntityRef(value: unknown): value is EntityRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EntityRef>;
  return (
    typeof candidate.kind === "string" &&
    isEntityKind(candidate.kind) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.id.length <= MAX_ENTITY_ID_LENGTH &&
    (candidate.kind === "holding" ? HOLDING_ID.test(candidate.id.toUpperCase()) : UUID_ID.test(candidate.id))
  );
}

export function normalizeEntityRef(ref: EntityRef): EntityRef | null {
  const normalized = ref.kind === "holding" ? { ...ref, id: ref.id.toUpperCase() } : ref;
  return isEntityRef(normalized) ? normalized : null;
}

export function entityRefKey(ref: EntityRef): string {
  const normalized = normalizeEntityRef(ref);
  if (!normalized) throw new Error("INVALID_ENTITY_REF");
  return `${normalized.kind}:${normalized.id}`;
}

export function serializeEntityRef(ref: EntityRef): string {
  const normalized = normalizeEntityRef(ref);
  if (!normalized) throw new Error("INVALID_ENTITY_REF");
  return `${normalized.kind}:${encodeURIComponent(normalized.id)}`;
}

export function parseEntityRef(value: string | null | undefined): EntityRef | null {
  if (!value || value.length > MAX_ENTITY_ID_LENGTH + 40) return null;
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  if (!isEntityKind(kind)) return null;
  try {
    const id = decodeURIComponent(value.slice(separator + 1));
    return normalizeEntityRef({ kind, id });
  } catch {
    return null;
  }
}

export function entityHref(ref: EntityRef): string {
  const normalized = normalizeEntityRef(ref);
  if (!normalized) throw new Error("INVALID_ENTITY_REF");
  if (normalized.kind === "holding") {
    return `/fund/position/${encodeURIComponent(normalized.id)}`;
  }
  const descriptor = ENTITY_REGISTRY[normalized.kind];
  const params = new URLSearchParams({ [descriptor.queryKey]: serializeEntityRef(normalized) });
  return `${descriptor.route}?${params.toString()}`;
}

export function searchableEntityKinds(): EntityKind[] {
  return ENTITY_KINDS.filter((kind) => ENTITY_REGISTRY[kind].searchable);
}
