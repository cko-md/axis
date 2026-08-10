import { classifyFreshness, FRESHNESS_SLAS } from "./provenance";

type LiabilityRow = {
  authority?: unknown;
  source?: unknown;
  provider?: unknown;
  provider_record_id?: unknown;
  connection_id?: unknown;
  generation_id?: unknown;
  retrieved_at?: unknown;
  reconciliation_state?: unknown;
};

type Connection = {
  id?: unknown;
  provider?: unknown;
  status?: unknown;
  authority?: unknown;
  verified_at?: unknown;
};

type Coverage = {
  connection_id?: unknown;
  provider?: unknown;
  component?: unknown;
  complete?: unknown;
  record_count?: unknown;
  retrieved_at?: unknown;
  availability_status?: unknown;
  generation_id?: unknown;
  generation_hash?: unknown;
};

export type LiabilityCoverageReason =
  | "LIABILITY_PROVENANCE_UNAVAILABLE"
  | "LIABILITY_COVERAGE_UNAVAILABLE";

export function validateLiabilityCoverage(
  rows: readonly LiabilityRow[],
  connections: readonly Connection[],
  coverage: readonly Coverage[],
  now = Date.now(),
): LiabilityCoverageReason | null {
  const applicable = connections.filter((connection) =>
    connection.provider === "plaid"
    && connection.status === "linked"
    && connection.authority === "provider_verified"
    && typeof connection.verified_at === "string"
    && connection.verified_at,
  );
  if (rows.length === 0 && applicable.length === 0) return null;
  const byId = new Map(applicable.map((connection) => [connection.id, connection]));
  for (const row of rows) {
    if (
      row.authority !== "provider"
      || row.source !== "plaid"
      || row.provider !== "plaid"
      || typeof row.provider_record_id !== "string"
      || !row.provider_record_id
      || typeof row.connection_id !== "string"
      || !byId.has(row.connection_id)
      || typeof row.generation_id !== "string"
      || !row.generation_id
      || row.reconciliation_state !== "matched"
      || typeof row.retrieved_at !== "string"
      || classifyFreshness(row.retrieved_at, FRESHNESS_SLAS.accountBalance, now) !== "fresh"
    ) return "LIABILITY_PROVENANCE_UNAVAILABLE";
  }
  for (const connection of applicable) {
    const connectionRows = rows.filter((row) => row.connection_id === connection.id);
    const fact = coverage.find((candidate) =>
      candidate.connection_id === connection.id
      && candidate.provider === "plaid"
      && candidate.component === "liabilities",
    );
    if (
      !fact
      || fact.complete !== true
      || fact.availability_status !== "available"
      || !Number.isSafeInteger(fact.record_count)
      || fact.record_count !== connectionRows.length
      || typeof fact.generation_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fact.generation_id)
      || typeof fact.generation_hash !== "string"
      || !/^[0-9a-f]{64}$/.test(fact.generation_hash)
      || typeof fact.retrieved_at !== "string"
      || classifyFreshness(fact.retrieved_at, FRESHNESS_SLAS.accountBalance, now) !== "fresh"
      || connectionRows.some((row) => row.generation_id !== fact.generation_id)
    ) return "LIABILITY_COVERAGE_UNAVAILABLE";
  }
  return null;
}
