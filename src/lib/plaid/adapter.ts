/**
 * Plaid account adapter (§10). API routes call `getAccounts(userId)` and get the
 * shared `Result<Account[]>` with normalized, provenance-aware accounts — never
 * a Plaid-shaped payload, never a raw token. Read-only; the access token is read
 * server-side from the encrypted store and never leaves the server.
 *
 * Self-contained in lib (creds via env, host resolved locally) so it imports no
 * route code; another provider or a cache-first wrapper implements this same
 * interface without touching call sites.
 */

import { optionalEnv } from "@/lib/env";
import {
  getPlaidAccessConnections,
  type PlaidAccessConnection,
} from "@/lib/fund/plaidTokens";
import { fail, failFromException, ok, type Result } from "@/lib/integrations/types";
import { normalizeAccounts, type Account, type RawPlaidAccount } from "./account";
import { normalizeTransactions, type RawPlaidTransaction, type Transaction } from "./transaction";
import { normalizeLiabilities, type AccountSummary, type Liability, type RawLiabilities } from "./liability";
import { admitPlaidRequest } from "./admission";
import { isPlainPlaidRecord, plaidRequest } from "./request";
import { normalizeFinancialCurrency, strictExactMinorUnits } from "@/lib/fund/financialTruth";

export interface AccountAdapter {
  readonly provider: string;
  isConfigured(): boolean;
  /** Normalized account balances for the user's linked item. */
  getAccounts(userId: string): Promise<Result<Account[]>>;
  /** Normalized recent transactions (default last ~30 days) for the user's item. */
  getTransactions(userId: string, opts?: { days?: number }): Promise<Result<Transaction[]>>;
  /** Normalized liabilities (credit/student/mortgage) for the user's item. */
  getLiabilities(userId: string): Promise<Result<Liability[]>>;
}

function getCreds() {
  const clientId = optionalEnv("PLAID_CLIENT_ID");
  const secret = optionalEnv("PLAID_SECRET");
  const env = optionalEnv("PLAID_ENV") || "sandbox";
  if (!clientId || !secret) return null;
  return { clientId, secret, env };
}

async function verifiedConnections<T>(
  userId: string,
  operationName: string,
  operation: (connection: PlaidAccessConnection) => Promise<T[]>,
): Promise<Result<T[]>> {
  const admission = await admitPlaidRequest(
    userId,
    30,
    1_000,
    `axis:plaid-read:${operationName}`,
  );
  if (admission !== "allowed") {
    return fail<T[]>(
      admission === "limited" ? "rate_limited" : "provider_error",
      admission === "limited"
        ? "Plaid read rate limit reached."
        : "Plaid read admission is temporarily unavailable.",
      { provider: "plaid", retryable: true, status: admission === "limited" ? 429 : 503 },
    );
  }
  let connections: PlaidAccessConnection[];
  try {
    connections = await getPlaidAccessConnections(userId);
  } catch {
    return fail<T[]>("provider_error", "The bank credential store is temporarily unavailable.", {
      provider: "plaid",
      retryable: true,
      status: 503,
    });
  }
  if (connections.length === 0) {
    return fail<T[]>("auth_expired", "No complete set of linked bank accounts is available.", {
      provider: "plaid",
      retryable: false,
    });
  }
  try {
    return ok(await operation(connections[0]));
  } catch (error) {
    return failFromException<T[]>(
      error,
      "The linked Plaid connection is unavailable.",
      { provider: "plaid" },
    );
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validateAccount(value: unknown): RawPlaidAccount | null {
  if (!isPlainPlaidRecord(value) || !boundedString(value.account_id, 256) || !boundedString(value.name, 200)) {
    return null;
  }
  if (!isPlainPlaidRecord(value.balances)) return null;
  const currency = normalizeFinancialCurrency(value.balances.iso_currency_code, "");
  if (!currency) return null;
  for (const amount of [value.balances.current, value.balances.available]) {
    if (amount !== null && amount !== undefined && strictExactMinorUnits(amount, currency) === null) return null;
  }
  if (
    value.persistent_account_id !== null
    && value.persistent_account_id !== undefined
    && !boundedString(value.persistent_account_id, 256)
  ) return null;
  return value as unknown as RawPlaidAccount;
}

function validateTransaction(value: unknown): RawPlaidTransaction | null {
  if (
    !isPlainPlaidRecord(value)
    || !boundedString(value.transaction_id, 256)
    || !boundedString(value.name, 512)
    || !boundedString(value.date, 10)
  ) return null;
  const currency = normalizeFinancialCurrency(value.iso_currency_code, "");
  if (!currency || strictExactMinorUnits(value.amount, currency) === null) return null;
  return value as unknown as RawPlaidTransaction;
}

export const plaidAccountAdapter: AccountAdapter = {
  provider: "plaid",

  isConfigured() {
    return !!getCreds();
  },

  async getAccounts(userId) {
    const creds = getCreds();
    if (!creds) {
      return fail<Account[]>("not_supported", "Plaid isn't configured (set PLAID_CLIENT_ID / PLAID_SECRET).", {
        provider: "plaid",
        retryable: false,
      });
    }

    return verifiedConnections(userId, "accounts", async (connection) => {
      const data = await plaidRequest(creds, "/accounts/balance/get", connection.accessToken, {}, {
        deadline: Date.now() + 9_000,
        expectedItemId: connection.itemId,
        maxResponseBytes: 128_000,
      });
      if (!Array.isArray(data.accounts) || data.accounts.length > 64) {
        throw new Error("PLAID_ACCOUNT_RESPONSE_INVALID");
      }
      const accounts = data.accounts.map(validateAccount);
      if (accounts.some((account) => account === null)) throw new Error("PLAID_ACCOUNT_RESPONSE_INVALID");
      return normalizeAccounts(accounts as RawPlaidAccount[], {
        provider: "plaid",
        connectionId: connection.id,
      });
    });
  },

  async getTransactions(userId, opts) {
    const creds = getCreds();
    if (!creds) {
      return fail<Transaction[]>("not_supported", "Plaid isn't configured (set PLAID_CLIENT_ID / PLAID_SECRET).", {
        provider: "plaid",
        retryable: false,
      });
    }
    const days = Math.min(730, Math.max(1, opts?.days ?? 30));
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return verifiedConnections(userId, "transactions", async (connection) => {
      const transactions: RawPlaidTransaction[] = [];
      let expectedTotal: number | null = null;
      const deadline = Date.now() + 10_000;
      for (let offset = 0; offset < 5_000; offset += 250) {
        const data = await plaidRequest(
          creds,
          "/transactions/get",
          connection.accessToken,
          {
            start_date: start.toISOString().slice(0, 10),
            end_date: end.toISOString().slice(0, 10),
            options: { count: 250, offset },
          },
          {
            deadline,
            expectedItemId: connection.itemId,
            maxResponseBytes: 1_000_000,
          },
        );
        if (
          !Array.isArray(data.transactions)
          || data.transactions.length > 250
          || !Number.isSafeInteger(data.total_transactions)
          || (data.total_transactions as number) < 0
          || (data.total_transactions as number) > 5_000
        ) throw new Error("PLAID_TRANSACTION_RESPONSE_INCOMPLETE");
        const total = data.total_transactions as number;
        if (expectedTotal === null) expectedTotal = total;
        if (expectedTotal !== total) throw new Error("PLAID_TRANSACTION_GENERATION_CHANGED");
        const page = data.transactions.map(validateTransaction);
        if (page.some((transaction) => transaction === null)) {
          throw new Error("PLAID_TRANSACTION_RESPONSE_INVALID");
        }
        transactions.push(...page as RawPlaidTransaction[]);
        if (transactions.length >= total) break;
        if (data.transactions.length === 0) throw new Error("PLAID_TRANSACTION_RESPONSE_INCOMPLETE");
      }
      if (expectedTotal === null || transactions.length !== expectedTotal) {
        throw new Error("PLAID_TRANSACTION_RESPONSE_INCOMPLETE");
      }
      return normalizeTransactions(transactions, {
        provider: "plaid",
        connectionId: connection.id,
      }).map((transaction) => ({
        ...transaction,
        id: `${connection.id}:${transaction.id}`,
      }));
    });
  },

  async getLiabilities(userId) {
    const creds = getCreds();
    if (!creds) {
      return fail<Liability[]>("not_supported", "Plaid isn't configured (set PLAID_CLIENT_ID / PLAID_SECRET).", {
        provider: "plaid",
        retryable: false,
      });
    }
    return verifiedConnections(userId, "liabilities", async (connection) => {
      const data = await plaidRequest(creds, "/liabilities/get", connection.accessToken, {}, {
        deadline: Date.now() + 9_000,
        expectedItemId: connection.itemId,
        maxResponseBytes: 1_000_000,
      });
      if (!Array.isArray(data.accounts) || data.accounts.length > 64 || !isPlainPlaidRecord(data.liabilities)) {
        throw new Error("PLAID_LIABILITY_RESPONSE_INVALID");
      }
      // Build the account_id -> summary map the pure normalizer joins against.
      const accountsById: Record<string, AccountSummary> = {};
      for (const candidate of data.accounts) {
        const a = validateAccount(candidate);
        if (!a?.account_id || !a.balances?.iso_currency_code) {
          throw new Error("PLAID_LIABILITY_ACCOUNT_INVALID");
        }
        accountsById[a.account_id] = {
            name: a.name,
            balanceCurrent: a.balances?.current ?? null,
            currency: a.balances.iso_currency_code,
        };
      }
      for (const type of ["credit", "student", "mortgage"] as const) {
        const entries = data.liabilities[type];
        if (entries !== undefined && entries !== null) {
          if (!Array.isArray(entries) || entries.length > 256) throw new Error("PLAID_LIABILITY_RESPONSE_INVALID");
          for (const entry of entries) {
            if (
              !isPlainPlaidRecord(entry)
              || !boundedString(entry.account_id, 256)
              || !accountsById[entry.account_id]
            ) throw new Error("PLAID_LIABILITY_RESPONSE_INVALID");
          }
        }
      }
      return normalizeLiabilities(data.liabilities as RawLiabilities, accountsById, {
        provider: "plaid",
        connectionId: connection.id,
      }).map((liability) => ({
        ...liability,
        accountId: `${connection.id}:${liability.accountId}`,
      }));
    });
  },
};

export function resolveAccountAdapter(): AccountAdapter {
  return plaidAccountAdapter;
}
