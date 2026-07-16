import { entityHref } from "@/lib/entities/registry";
import { toMajorUnitsIn, toMinorUnitsIn } from "@/lib/fund/currency";
import type { Database } from "@/lib/supabase/database.types";
import type { EntitySummary } from "@/lib/entities/types";

type TableRow<Name extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][Name]["Row"];

export type NoteEntityRow = Pick<
  TableRow<"notes">,
  "id" | "title" | "folder" | "tags" | "updated_at"
>;
export type TaskEntityRow = Pick<
  TableRow<"agent_tasks">,
  "id" | "objective" | "status" | "source_skill" | "updated_at"
>;
export type AgendaTaskEntityRow = Pick<
  TableRow<"tasks">,
  "id" | "title" | "status" | "priority" | "category" | "deadline" | "updated_at"
>;
export type PersonEntityRow = Pick<
  TableRow<"people">,
  "id" | "name" | "role" | "tag" | "last_contact_on" | "follow_up_on" | "updated_at"
>;
export type SignalEntityRow = Pick<
  TableRow<"signals">,
  "id" | "title" | "signal_type" | "source" | "read_at" | "routed_at" | "updated_at"
>;
export type ApprovalEntityRow = Pick<
  TableRow<"approvals">,
  "id" | "action_class" | "requirement" | "status" | "scope" | "expires_at" | "created_at"
>;
export type RoutineRunEntityRow = Pick<
  TableRow<"routine_runs">,
  | "id"
  | "routine_key"
  | "routine_version"
  | "status"
  | "trigger"
  | "started_at"
  | "completed_at"
>;
export type AccountEntityRow = Pick<
  TableRow<"fund_connections">,
  "id" | "provider" | "institution" | "mask" | "status" | "updated_at"
>;
export type HoldingEntityRow = Pick<
  TableRow<"fund_holdings">,
  | "symbol"
  | "name"
  | "shares"
  | "cost_basis"
  | "source"
  | "currency"
  | "reconciliation_state"
  | "retrieved_at"
  | "updated_at"
>;

export type HoldingAggregate = Readonly<{
  symbol: string;
  name: string;
  shares: number;
  costBasis: number | null;
  currency: string | null;
  sources: readonly string[];
  reconciliationState: string | null;
  retrievedAt: string | null;
  updatedAt: string | null;
  rowCount: number;
}>;

function cleanText(value: string | null | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function titleCase(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function oldestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function normalizeCurrency(value: string | null | undefined): string {
  return cleanText(value, "USD").toUpperCase();
}

function safeNumber(value: number): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatShares(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 3,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function projectNote(row: NoteEntityRow): EntitySummary {
  const ref = { kind: "note", id: row.id } as const;
  return {
    ref,
    title: cleanText(row.title, "Untitled note"),
    subtitle: cleanText(row.folder, "Notes"),
    href: entityHref(ref),
    updatedAt: row.updated_at,
    meta: row.tags.length > 0 ? [{ label: "Tags", value: row.tags.join(", ") }] : [],
  };
}

export function projectTask(row: TaskEntityRow): EntitySummary {
  const ref = { kind: "task", id: row.id } as const;
  const sourceSkill = row.source_skill?.trim();
  return {
    ref,
    title: cleanText(row.objective, "Untitled task"),
    subtitle: sourceSkill ? `Agent task · ${sourceSkill}` : "Agent task",
    href: entityHref(ref),
    status: row.status,
    updatedAt: row.updated_at,
    meta: [
      { label: "Status", value: titleCase(row.status) },
      ...(sourceSkill ? [{ label: "Source skill", value: sourceSkill }] : []),
    ],
  };
}

export function projectAgendaTask(row: AgendaTaskEntityRow): EntitySummary {
  const ref = { kind: "agenda_task", id: row.id } as const;
  return {
    ref,
    title: cleanText(row.title, "Untitled agenda task"),
    subtitle: `${titleCase(row.category)} · ${titleCase(row.priority)} priority`,
    href: entityHref(ref),
    status: row.status,
    updatedAt: row.updated_at,
    meta: [
      { label: "Status", value: titleCase(row.status) },
      ...(row.deadline ? [{ label: "Deadline", value: row.deadline }] : []),
    ],
  };
}

export function projectPerson(row: PersonEntityRow): EntitySummary {
  const ref = { kind: "person", id: row.id } as const;
  return {
    ref,
    title: cleanText(row.name, "Unnamed person"),
    subtitle: cleanText(row.role, titleCase(row.tag)),
    href: entityHref(ref),
    updatedAt: row.updated_at,
    meta: [
      { label: "Relationship", value: titleCase(row.tag) },
      ...(row.follow_up_on ? [{ label: "Follow up", value: row.follow_up_on }] : []),
      ...(row.last_contact_on ? [{ label: "Last contact", value: row.last_contact_on }] : []),
    ],
  };
}

export function projectSignal(row: SignalEntityRow): EntitySummary {
  const ref = { kind: "signal", id: row.id } as const;
  return {
    ref,
    title: cleanText(row.title, "Untitled signal"),
    subtitle: `${titleCase(row.signal_type)} · ${cleanText(row.source, "Unknown source")}`,
    href: entityHref(ref),
    status: row.routed_at ? "routed" : row.read_at ? "read" : "unread",
    updatedAt: row.updated_at,
    meta: [
      { label: "Type", value: titleCase(row.signal_type) },
      { label: "Source", value: cleanText(row.source, "Unknown") },
    ],
  };
}

export function projectApproval(row: ApprovalEntityRow): EntitySummary {
  const ref = { kind: "approval", id: row.id } as const;
  const actionClass = titleCase(row.action_class);
  return {
    ref,
    title: `${actionClass} approval`,
    subtitle: `${titleCase(row.requirement)} · ${titleCase(row.scope)}`,
    href: entityHref(ref),
    status: row.status,
    updatedAt: row.created_at,
    meta: [
      { label: "Action class", value: actionClass },
      { label: "Requirement", value: titleCase(row.requirement) },
      { label: "Status", value: titleCase(row.status) },
      ...(row.expires_at ? [{ label: "Expires", value: row.expires_at }] : []),
    ],
  };
}

export function projectRoutineRun(row: RoutineRunEntityRow): EntitySummary {
  const ref = { kind: "routine_run", id: row.id } as const;
  return {
    ref,
    title: cleanText(titleCase(row.routine_key), "Routine run"),
    subtitle: `Version ${row.routine_version} · ${titleCase(row.trigger)}`,
    href: entityHref(ref),
    status: row.status,
    updatedAt: row.completed_at ?? row.started_at,
    meta: [
      { label: "Status", value: titleCase(row.status) },
      { label: "Trigger", value: titleCase(row.trigger) },
      { label: "Started", value: row.started_at },
    ],
  };
}

export function projectAccount(row: AccountEntityRow): EntitySummary {
  const ref = { kind: "account", id: row.id } as const;
  const provider = titleCase(row.provider);
  const mask = row.mask?.replace(/\D/g, "").slice(-4);
  return {
    ref,
    title: cleanText(row.institution, `${provider} account`),
    subtitle: mask ? `${provider} · •••• ${mask}` : provider,
    href: entityHref(ref),
    status: row.status,
    updatedAt: row.updated_at,
    meta: [
      { label: "Provider", value: provider },
      { label: "Status", value: titleCase(row.status) },
    ],
  };
}

/**
 * Aggregate provider-partitioned holding rows by normalized symbol. Monetary
 * totals are summed in integer minor units and are withheld for mixed-currency
 * groups; this layer never performs an implicit currency conversion.
 */
export function aggregateHoldingRows(rows: readonly HoldingEntityRow[]): HoldingAggregate[] {
  type MutableAggregate = {
    symbol: string;
    name: string;
    shares: number;
    costBasisMinor: number;
    currency: string | null;
    sources: Set<string>;
    reconciliationStates: Set<string>;
    retrievedAt: string | null;
    updatedAt: string | null;
    rowCount: number;
  };

  const bySymbol = new Map<string, MutableAggregate>();
  for (const row of rows) {
    const symbol = cleanText(row.symbol, "").toUpperCase();
    if (!symbol) continue;
    const currency = normalizeCurrency(row.currency);
    const source = cleanText(row.source, "unknown").toLocaleLowerCase();
    const state = row.reconciliation_state?.trim();
    const existing = bySymbol.get(symbol);
    if (!existing) {
      bySymbol.set(symbol, {
        symbol,
        name: cleanText(row.name, symbol),
        shares: safeNumber(row.shares),
        costBasisMinor: toMinorUnitsIn(row.cost_basis, currency),
        currency,
        sources: new Set([source]),
        reconciliationStates: new Set(state ? [state] : []),
        retrievedAt: row.retrieved_at,
        updatedAt: row.updated_at,
        rowCount: 1,
      });
      continue;
    }

    existing.shares += safeNumber(row.shares);
    existing.sources.add(source);
    if (state) existing.reconciliationStates.add(state);
    existing.retrievedAt = oldestIso(existing.retrievedAt, row.retrieved_at);
    existing.updatedAt = latestIso(existing.updatedAt, row.updated_at);
    existing.rowCount += 1;
    if (existing.currency === currency) {
      existing.costBasisMinor += toMinorUnitsIn(row.cost_basis, currency);
    } else {
      existing.currency = null;
      existing.costBasisMinor = 0;
    }
  }

  return [...bySymbol.values()]
    .map((aggregate): HoldingAggregate => {
      const states = [...aggregate.reconciliationStates];
      return {
        symbol: aggregate.symbol,
        name: aggregate.name,
        shares: aggregate.shares,
        costBasis:
          aggregate.currency === null
            ? null
            : toMajorUnitsIn(aggregate.costBasisMinor, aggregate.currency),
        currency: aggregate.currency,
        sources: [...aggregate.sources].sort(),
        reconciliationState:
          states.length === 0 ? null : states.length === 1 ? states[0] : "conflicting",
        retrievedAt: aggregate.retrievedAt,
        updatedAt: aggregate.updatedAt,
        rowCount: aggregate.rowCount,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function projectHolding(aggregate: HoldingAggregate): EntitySummary {
  const ref = { kind: "holding", id: aggregate.symbol } as const;
  return {
    ref,
    title: aggregate.symbol,
    subtitle: aggregate.name,
    href: entityHref(ref),
    status: aggregate.reconciliationState ?? undefined,
    updatedAt: aggregate.updatedAt ?? undefined,
    meta: [
      { label: "Shares", value: formatShares(aggregate.shares) },
      {
        label: "Cost basis",
        value:
          aggregate.costBasis === null || aggregate.currency === null
            ? "Mixed currencies"
            : formatMoney(aggregate.costBasis, aggregate.currency),
      },
      { label: "Sources", value: aggregate.sources.join(", ") },
      ...(aggregate.retrievedAt
        ? [{ label: "Data retrieved", value: aggregate.retrievedAt }]
        : []),
    ],
  };
}

export function projectHoldingRows(rows: readonly HoldingEntityRow[]): EntitySummary[] {
  return aggregateHoldingRows(rows).map(projectHolding);
}
