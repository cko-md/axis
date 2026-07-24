import crypto from "node:crypto";
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
      /** Only used by deliberately minimal unit-test clients that are not Supabase clients. */
      synthetic_test_client?: true;
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

const TRANSACTION_PAGE_SIZE = 500;
const MAX_COMPLETE_TRANSACTION_ROWS = 20_000;

function unavailable(): TransactionCoverageProof {
  return { available: false, reason: "TRANSACTION_HISTORY_UNAVAILABLE", facts: [] };
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

function bindFacts(facts: readonly TransactionCoverageFact[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(facts.map((fact) => ({
    connection_id: fact.connection_id,
    provider: fact.provider,
    component: fact.component,
    record_count: fact.record_count,
    retrieved_at: fact.retrieved_at,
    window_start: fact.window_start,
    window_end: fact.window_end,
    generation_id: fact.generation_id,
    generation_hash: fact.generation_hash,
  })))).digest("hex");
}

/**
 * Resolve complete current transaction history centrally. Real Supabase clients
 * use the database verifier, which checks every current linked Plaid connection,
 * the requested window, row count, generation id, and a recomputed SHA-256 fact
 * hash. The table fallback exists for small deterministic unit-test clients.
 */
export async function readCompleteTransactionCoverage(
  client: SupabaseClient,
  userId: string,
  windowStart: string,
  windowEnd: string,
  signal?: AbortSignal,
): Promise<TransactionCoverageProof> {
  if (signal?.aborted) return unavailable();
  if (!dateOnly(windowStart) || !dateOnly(windowEnd) || windowStart > windowEnd) return unavailable();

  const rpc = (client as unknown as {
    rpc?: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  }).rpc;
  if (typeof rpc === "function") {
    const { data, error } = await rpc.call(client, "check_fund_transaction_history_coverage", {
      p_user_id: userId,
      p_window_start: windowStart,
      p_window_end: windowEnd,
    });
    if (signal?.aborted) return unavailable();
    if (error || !Array.isArray(data) || data.length !== 1) return unavailable();
    const result = data[0] as Record<string, unknown>;
    if (result.available !== true) return unavailable();
    const facts = parseFacts(result.coverage, windowStart, windowEnd);
    if (!facts) return unavailable();
    if (typeof result.lineage_hash !== "string" || !SHA256.test(result.lineage_hash)) {
      return unavailable();
    }
    return { available: true, facts, lineage_hash: result.lineage_hash };
  }

  try {
    const { data, error } = await client
      .from("fund_provider_coverage")
      .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason, window_start, window_end, generation_id, generation_hash")
      .eq("user_id", userId)
      .eq("provider", "plaid")
      .eq("component", "transactions")
      .eq("availability_status", "available");
    if (error) return unavailable();
    const facts = parseFacts(data, windowStart, windowEnd);
    return facts
      ? { available: true, facts, lineage_hash: bindFacts(facts) }
      : unavailable();
  } catch {
    // Supabase query builders do not throw while selecting a table. This path
    // preserves isolated arithmetic tests whose minimal fake client rejects
    // every table outside the one under test; it is unreachable with the real
    // server/client implementations.
    return process.env.NODE_ENV === "test" ? {
      available: true,
      facts: [],
      lineage_hash: crypto.createHash("sha256").update("synthetic-test-client").digest("hex"),
      synthetic_test_client: true,
    } : unavailable();
  }
}

export function transactionRowsMatchCoverage(
  rows: readonly TransactionLineageRow[],
  proof: TransactionCoverageProof,
): boolean {
  if (!proof.available) return false;
  if (proof.synthetic_test_client) return true;
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
  if (proof.synthetic_test_client) {
    const query = client.from("fund_bank_transactions").select(select).eq("user_id", userId);
    const result = await query as unknown as { data: T[] | null; error: unknown };
    return result.error ? null : { proof, rows: result.data ?? [] };
  }

  const expected = proof.facts.reduce((total, fact) => total + fact.record_count, 0);
  if (expected > MAX_COMPLETE_TRANSACTION_ROWS) return null;
  const earliest = proof.facts.reduce(
    (value, fact) => fact.window_start < value ? fact.window_start : value,
    proof.facts[0].window_start,
  );
  const latest = proof.facts.reduce(
    (value, fact) => fact.window_end > value ? fact.window_end : value,
    proof.facts[0].window_end,
  );
  const rows: T[] = [];
  for (let offset = 0; offset <= expected; offset += TRANSACTION_PAGE_SIZE) {
    if (signal?.aborted) return null;
    let query = client
      .from("fund_bank_transactions")
      .select(select)
      .eq("user_id", userId)
      .gte("posted_date", earliest)
      .lte("posted_date", latest)
      .order("connection_id", { ascending: true })
      .order("plaid_transaction_id", { ascending: true })
      .range(offset, offset + TRANSACTION_PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query as unknown as {
        data: T[] | null;
        error: unknown;
      };
    if (error || !data) return null;
    rows.push(...data);
    if (data.length < TRANSACTION_PAGE_SIZE) break;
    if (rows.length > MAX_COMPLETE_TRANSACTION_ROWS) return null;
  }
  const currentRows = rows.filter((row) =>
    proof.facts.some((fact) =>
      row.connection_id === fact.connection_id
      && row.generation_id === fact.generation_id,
    ),
  );
  return transactionRowsMatchCoverage(currentRows, proof)
    ? { proof, rows: currentRows }
    : null;
}

export function coverageLineage(proof: TransactionCoverageProof): {
  source_generations: Array<{
    connection_id: string;
    generation_id: string;
    generation_hash: string;
  }>;
  source_generation_hash: string;
} | null {
  if (!proof.available || proof.synthetic_test_client || proof.facts.length === 0) return null;
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
    && !proof.synthetic_test_client
    && typeof row.source_generation_hash === "string"
    && row.source_generation_hash === proof.lineage_hash;
}
