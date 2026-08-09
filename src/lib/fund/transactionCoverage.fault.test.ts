import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  readCompleteTransactionCoverage,
  readCompleteTransactionRows,
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
  it("fails observably when the database coverage verifier is unavailable", async () => {
    const from = vi.fn(() => { throw new Error("table fallback must not run"); });
    const result = readCompleteTransactionCoverage(
      { from } as unknown as SupabaseClient,
      "user-1",
      "2026-04-24",
      "2026-07-23",
    );

    await expect(result).rejects.toThrow("TRANSACTION_COVERAGE_RPC_UNAVAILABLE");
    expect(from).not.toHaveBeenCalled();
  });

  it("accepts only a valid database-verifier proof", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        available: true,
        coverage: proof(1).facts,
        lineage_hash: "c".repeat(64),
      }],
      error: null,
    }));

    const result = await readCompleteTransactionCoverage(
      { rpc } as unknown as SupabaseClient,
      "user-1",
      "2026-04-24",
      "2026-07-23",
    );

    expect(result).toMatchObject({ available: true, lineage_hash: "c".repeat(64) });
    expect(rpc).toHaveBeenCalledWith("check_fund_transaction_history_coverage", {
      p_user_id: "user-1",
      p_window_start: "2026-04-24",
      p_window_end: "2026-07-23",
    });
  });

  it("keeps the exact authoritative unavailable row non-operational", async () => {
    const rpc = vi.fn(async () => ({
      data: [{
        available: false,
        reason: "TRANSACTION_HISTORY_UNAVAILABLE",
        coverage: [],
        lineage_hash: null,
      }],
      error: null,
    }));

    await expect(readCompleteTransactionCoverage(
      { rpc } as unknown as SupabaseClient,
      "user-1",
      "2026-04-24",
      "2026-07-23",
    )).resolves.toEqual({
      available: false,
      reason: "TRANSACTION_HISTORY_UNAVAILABLE",
      facts: [],
    });
  });

  it("rejects invalid windows and oversized authoritative generations", async () => {
    await expect(readCompleteTransactionCoverage(
      { rpc: vi.fn() } as unknown as SupabaseClient,
      "user-1",
      "invalid",
      "2026-07-23",
    )).rejects.toThrow("TRANSACTION_COVERAGE_WINDOW_INVALID");

    const rpc = vi.fn(async () => ({
      data: [{
        available: true,
        coverage: proof(20_001).facts,
        lineage_hash: "c".repeat(64),
      }],
      error: null,
    }));
    await expect(readCompleteTransactionRows(
      { rpc, from: vi.fn() } as unknown as SupabaseClient,
      "user-1",
      "2026-04-24",
      "2026-07-23",
      "connection_id, generation_id",
    )).rejects.toThrow("TRANSACTION_GENERATION_LIMIT_EXCEEDED");
  });

  it.each(["reject", "resolve-error"] as const)(
    "keeps a mid-flight generation-query abort quiet when the query %s path fires",
    async (mode) => {
      const controller = new AbortController();
      const rpc = vi.fn(async () => ({
        data: [{
          available: true,
          coverage: proof(1).facts,
          lineage_hash: "c".repeat(64),
        }],
        error: null,
      }));
      const from = vi.fn(() => {
        const chain: Record<string, unknown> = {};
        for (const method of ["select", "eq", "gte", "lte", "order", "range", "abortSignal"]) {
          chain[method] = vi.fn(() => chain);
        }
        chain.then = (
          resolve: (value: { data: null; error: DOMException }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          controller.abort();
          const abortError = new DOMException("aborted", "AbortError");
          const promise = mode === "reject"
            ? Promise.reject(abortError)
            : Promise.resolve({ data: null, error: abortError });
          return promise.then(resolve, reject);
        };
        return chain;
      });

      await expect(readCompleteTransactionRows(
        { rpc, from } as unknown as SupabaseClient,
        "user-1",
        "2026-04-24",
        "2026-07-23",
        "connection_id, generation_id",
        controller.signal,
      )).resolves.toBeNull();
    },
  );

  it("keeps a mid-flight coverage RPC abort quiet", async () => {
    const controller = new AbortController();
    const rpc = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(readCompleteTransactionCoverage(
      { rpc } as unknown as SupabaseClient,
      "user-1",
      "2026-04-24",
      "2026-07-23",
      controller.signal,
    )).resolves.toEqual({
      available: false,
      reason: "TRANSACTION_HISTORY_UNAVAILABLE",
      facts: [],
    });
  });

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

  it("pages the exact proven generation without legacy-row starvation", async () => {
    const currentRows = Array.from({ length: 501 }, (_, index) => ({
      id: `current-${index}`,
      connection_id: "connection-1",
      generation_id: GENERATION,
    }));
    const legacyRows = Array.from({ length: 500 }, (_, index) => ({
      id: `legacy-${index}`,
      connection_id: "legacy-connection",
      generation_id: "22222222-2222-4222-8222-222222222222",
    }));
    const ranges: Array<[number, number]> = [];
    const exactFilters: boolean[] = [];
    const from = vi.fn(() => {
      const filters = new Map<string, unknown>();
      let range: [number, number] = [0, 499];
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn((key: string, value: unknown) => {
        filters.set(key, value);
        return chain;
      });
      for (const method of ["gte", "lte", "order"]) chain[method] = vi.fn(() => chain);
      chain.range = vi.fn((start: number, end: number) => {
        range = [start, end];
        ranges.push(range);
        return chain;
      });
      chain.then = (
        resolve: (value: { data: unknown[]; error: null }) => unknown,
        reject: (reason: unknown) => unknown,
      ) => {
        const exact = filters.get("connection_id") === "connection-1"
          && filters.get("generation_id") === GENERATION
          && filters.get("provider") === "plaid"
          && filters.get("authority") === "provider";
        exactFilters.push(exact);
        const source = exact ? currentRows : [...legacyRows, ...currentRows];
        return Promise.resolve({ data: source.slice(range[0], range[1] + 1), error: null })
          .then(resolve, reject);
      };
      return chain;
    });
    const rpc = vi.fn(async () => ({
      data: [{
        available: true,
        coverage: proof(501).facts,
        lineage_hash: "c".repeat(64),
      }],
      error: null,
    }));

    const result = await readCompleteTransactionRows<{ id: string; connection_id: string; generation_id: string }>(
      { from, rpc } as unknown as SupabaseClient,
      "user-1",
      "2026-04-24",
      "2026-07-23",
      "id, connection_id, generation_id",
    );

    expect(result?.rows).toHaveLength(501);
    expect(result?.rows[0]?.id).toBe("current-0");
    expect(ranges).toEqual([[0, 499], [500, 999]]);
    expect(exactFilters).toEqual([true, true]);
  });
});
