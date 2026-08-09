import type { SupabaseClient } from "@supabase/supabase-js";

export const TRANSACTION_HISTORY_DAYS = 90;
export const TRANSACTION_COVERAGE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export type TransactionCoverageFact = {
  connection_id: string;
  provider: "plaid";
  component: "transactions";
  complete: true;
  record_count: number;
  retrieved_at: string;
  window_start: string;
  window_end: string;
  generation_id: string;
  generation_hash: string;
};

export type TransactionCoverageProof =
  | {
      available: true;
      facts: TransactionCoverageFact[];
      lineage_hash: string;
    }
  | {
      available: false;
      reason: "TRANSACTION_HISTORY_UNAVAILABLE";
      facts: [];
    };

export type TransactionLineageRow = {
  connection_id?: unknown;
  generation_id?: unknown;
};

export class TransactionCoverageOperationalError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TransactionCoverageOperationalError";
  }
}

export class TransactionCoverageInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TransactionCoverageInputError";
  }
}

const TRANSACTION_PAGE_SIZE = 500;
const MAX_COMPLETE_TRANSACTION_ROWS = 20_000;

function unavailable(): TransactionCoverageProof {
  return { available: false, reason: "TRANSACTION_HISTORY_UNAVAILABLE", facts: [] };
}

function operational(code: string): never {
  throw new TransactionCoverageOperationalError(code);
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? value : null;
}

function parseFacts(
  rows: unknown,
  requestedStart: string,
  requestedEnd: string,
): TransactionCoverageFact[] | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const seen = new Set<string>();
  const facts: TransactionCoverageFact[] = [];
  const now = Date.now();
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== "object") return null;
    const row = candidate as Record<string, unknown>;
    const connectionId = typeof row.connection_id === "string" ? row.connection_id : "";
    const retrievedAt = typeof row.retrieved_at === "string" ? row.retrieved_at : "";
    const retrievedMs = Date.parse(retrievedAt);
    const windowStart = dateOnly(row.window_start);
    const windowEnd = dateOnly(row.window_end);
    const generationId = typeof row.generation_id === "string" ? row.generation_id : "";
    const generationHash = typeof row.generation_hash === "string" ? row.generation_hash : "";
    if (
      !connectionId
      || seen.has(connectionId)
      || row.provider !== "plaid"
      || row.component !== "transactions"
      || row.complete !== true
      || !Number.isSafeInteger(row.record_count)
      || (row.record_count as number) < 0
      || !Number.isFinite(retrievedMs)
      || retrievedMs > now + 60_000
      || now - retrievedMs > TRANSACTION_COVERAGE_MAX_AGE_MS
      || !windowStart
      || !windowEnd
      || windowStart > requestedStart
      || windowEnd < requestedEnd
      || !UUID.test(generationId)
      || !SHA256.test(generationHash)
    ) return null;
    seen.add(connectionId);
    facts.push({
      connection_id: connectionId,
      provider: "plaid",
      component: "transactions",
      complete: true,
      record_count: row.record_count as number,
      retrieved_at: retrievedAt,
      window_start: windowStart,
      window_end: windowEnd,
      generation_id: generationId,
      generation_hash: generationHash,
    });
  }
  return facts.sort((left, right) => left.connection_id.localeCompare(right.connection_id));
}

/**
 * Resolve complete current transaction history centrally. Real Supabase clients
 * use the database verifier, which checks every current linked Plaid connection,
 * the requested window, row count, generation id, and a recomputed SHA-256 fact
 * hash. Missing RPC authority fails closed; tests must implement this contract.
 */
export async function readCompleteTransactionCoverage(
  client: SupabaseClient,
  userId: string,
  windowStart: string,
  windowEnd: string,
  signal?: AbortSignal,
): Promise<TransactionCoverageProof> {
  if (signal?.aborted) return unavailable();
  if (!dateOnly(windowStart) || !dateOnly(windowEnd) || windowStart > windowEnd) {
    throw new TransactionCoverageInputError("TRANSACTION_COVERAGE_WINDOW_INVALID");
  }

  const rpc = (client as unknown as {
    rpc?: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  }).rpc;
  if (typeof rpc !== "function") operational("TRANSACTION_COVERAGE_RPC_UNAVAILABLE");
  let response: { data: unknown; error: unknown };
  try {
    response = await rpc.call(client, "check_fund_transaction_history_coverage", {
      p_user_id: userId,
      p_window_start: windowStart,
      p_window_end: windowEnd,
    });
  } catch {
    if (signal?.aborted) return unavailable();
    operational("TRANSACTION_COVERAGE_QUERY_FAILED");
  }
  const { data, error } = response;
  if (signal?.aborted) return unavailable();
  if (error) {
    operational("TRANSACTION_COVERAGE_QUERY_FAILED");
  }
  if (!Array.isArray(data) || data.length !== 1) {
    operational("TRANSACTION_COVERAGE_RESPONSE_MALFORMED");
  }
  const result = data[0] as Record<string, unknown>;
  if (result.available === false) {
    if (
      result.reason === "TRANSACTION_HISTORY_UNAVAILABLE"
      && Array.isArray(result.coverage)
      && result.coverage.length === 0
      && result.lineage_hash === null
    ) return unavailable();
    operational("TRANSACTION_COVERAGE_UNAVAILABLE_RESPONSE_MALFORMED");
  }
  if (result.available !== true) {
    operational("TRANSACTION_COVERAGE_AVAILABILITY_MALFORMED");
  }
  const facts = parseFacts(result.coverage, windowStart, windowEnd);
  if (!facts) {
    operational("TRANSACTION_COVERAGE_FACTS_MALFORMED");
  }
  if (typeof result.lineage_hash !== "string" || !SHA256.test(result.lineage_hash)) {
    operational("TRANSACTION_COVERAGE_LINEAGE_MALFORMED");
  }
  return { available: true, facts, lineage_hash: result.lineage_hash };
}

export function transactionRowsMatchCoverage(
  rows: readonly TransactionLineageRow[],
  proof: TransactionCoverageProof,
): boolean {
  if (!proof.available) return false;
  const generationByConnection = new Map(
    proof.facts.map((fact) => [fact.connection_id, fact.generation_id]),
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (
      typeof row.connection_id !== "string"
      || typeof row.generation_id !== "string"
      || generationByConnection.get(row.connection_id) !== row.generation_id
    ) return false;
    counts.set(row.connection_id, (counts.get(row.connection_id) ?? 0) + 1);
  }
  return proof.facts.every((fact) =>
    (counts.get(fact.connection_id) ?? 0) === fact.record_count,
  );
}

/**
 * Read the complete provider generation behind a coverage proof. The query is
 * paged explicitly because PostgREST commonly caps an otherwise unbounded
 * select at 1,000 rows. Consumers must filter the returned complete generation
 * in memory; filtering before verification would make a subset indistinguish-
 * able from a truncated source.
 */
export async function readCompleteTransactionRows<T extends TransactionLineageRow>(
  client: SupabaseClient,
  userId: string,
  requestedStart: string,
  requestedEnd: string,
  select: string,
  signal?: AbortSignal,
): Promise<{ proof: TransactionCoverageProof; rows: T[] } | null> {
  const proof = await readCompleteTransactionCoverage(
    client,
    userId,
    requestedStart,
    requestedEnd,
    signal,
  );
  if (!proof.available) return null;
  const expected = proof.facts.reduce((total, fact) => total + fact.record_count, 0);
  if (!Number.isSafeInteger(expected) || expected > MAX_COMPLETE_TRANSACTION_ROWS) {
    operational("TRANSACTION_GENERATION_LIMIT_EXCEEDED");
  }
  const rows: T[] = [];
  for (const fact of proof.facts) {
    const factRows: T[] = [];
    for (let offset = 0; offset < fact.record_count; offset += TRANSACTION_PAGE_SIZE) {
      if (signal?.aborted) return null;
      let query = client
        .from("fund_bank_transactions")
        .select(select)
        .eq("user_id", userId)
        .eq("provider", "plaid")
        .eq("authority", "provider")
        .eq("connection_id", fact.connection_id)
        .eq("generation_id", fact.generation_id)
        .gte("posted_date", fact.window_start)
        .lte("posted_date", fact.window_end)
        .order("plaid_transaction_id", { ascending: true })
        .range(offset, offset + TRANSACTION_PAGE_SIZE - 1);
      if (signal) query = query.abortSignal(signal);
      let response: { data: T[] | null; error: unknown };
      try {
        response = await query as unknown as { data: T[] | null; error: unknown };
      } catch {
        if (signal?.aborted) return null;
        operational("TRANSACTION_GENERATION_QUERY_FAILED");
      }
      if (signal?.aborted) return null;
      const { data, error } = response;
      if (error || !data) {
        operational(error ? "TRANSACTION_GENERATION_QUERY_FAILED" : "TRANSACTION_GENERATION_QUERY_MALFORMED");
      }
      factRows.push(...data);
      if (data.length < TRANSACTION_PAGE_SIZE) break;
    }
    if (factRows.length !== fact.record_count) {
      operational("TRANSACTION_GENERATION_COUNT_MISMATCH");
    }
    rows.push(...factRows);
  }
  if (!transactionRowsMatchCoverage(rows, proof)) {
    operational("TRANSACTION_GENERATION_LINEAGE_MISMATCH");
  }
  return { proof, rows };
}

export function coverageLineage(proof: TransactionCoverageProof): {
  source_generations: Array<{
    connection_id: string;
    generation_id: string;
    generation_hash: string;
  }>;
  source_generation_hash: string;
} | null {
  if (!proof.available || proof.facts.length === 0) return null;
  return {
    source_generations: proof.facts.map((fact) => ({
      connection_id: fact.connection_id,
      generation_id: fact.generation_id,
      generation_hash: fact.generation_hash,
    })),
    source_generation_hash: proof.lineage_hash,
  };
}

export function detectedRecurringMatchesCoverage(
  row: { source?: unknown; source_generation_hash?: unknown },
  proof: TransactionCoverageProof,
): boolean {
  if (row.source === "manual") return true;
  return proof.available
    && typeof row.source_generation_hash === "string"
    && row.source_generation_hash === proof.lineage_hash;
}
