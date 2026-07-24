import { describe, expect, it } from "vitest";
import {
  transactionRowsMatchCoverage,
  type TransactionCoverageProof,
} from "./transactionCoverage";

const GENERATION = "11111111-1111-4111-8111-111111111111";

function proof(recordCount: number): TransactionCoverageProof {
  return {
    available: true,
    lineage_hash: "a".repeat(64),
    facts: [{
      connection_id: "connection-1",
      provider: "plaid",
      component: "transactions",
      complete: true,
      record_count: recordCount,
      retrieved_at: new Date().toISOString(),
      window_start: "2026-04-24",
      window_end: "2026-07-23",
      generation_id: GENERATION,
      generation_hash: "b".repeat(64),
    }],
  };
}

describe("transaction coverage completeness", () => {
  it("accepts a verified empty generation only when its fact count is zero", () => {
    expect(transactionRowsMatchCoverage([], proof(0))).toBe(true);
    expect(transactionRowsMatchCoverage([], proof(1))).toBe(false);
  });

  it("rejects a truncated 1,000-row view of a 1,001-row generation", () => {
    const rows = Array.from({ length: 1_000 }, () => ({
      connection_id: "connection-1",
      generation_id: GENERATION,
    }));
    expect(transactionRowsMatchCoverage(rows, proof(1_001))).toBe(false);
    expect(transactionRowsMatchCoverage([...rows, rows[0]], proof(1_001))).toBe(true);
  });
});
