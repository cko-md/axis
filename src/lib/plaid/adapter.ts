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
import { getPlaidAccessToken } from "@/lib/fund/plaidTokens";
import { fail, failFromException, failFromStatus, ok, type Result } from "@/lib/integrations/types";
import { normalizeAccounts, type Account, type RawPlaidAccount } from "./account";
import { normalizeTransactions, type RawPlaidTransaction, type Transaction } from "./transaction";
import { normalizeLiabilities, type AccountSummary, type Liability, type RawLiabilities } from "./liability";

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

function plaidHost(env: string): string {
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
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

    const accessToken = await getPlaidAccessToken(userId);
    if (!accessToken) {
      return fail<Account[]>("auth_expired", "No linked bank account — connect one to see balances.", {
        provider: "plaid",
        retryable: false,
      });
    }

    try {
      const res = await fetch(`${plaidHost(creds.env)}/accounts/balance/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, access_token: accessToken }),
        cache: "no-store",
        signal: AbortSignal.timeout(7_000),
      });
      if (!res.ok) {
        return failFromStatus<Account[]>(res.status, "Plaid balances request failed.", { provider: "plaid" });
      }
      const data = (await res.json()) as { accounts?: RawPlaidAccount[] };
      return ok(normalizeAccounts(data.accounts ?? [], { provider: "plaid" }));
    } catch (e) {
      return failFromException<Account[]>(e, "Failed to fetch Plaid balances.", { provider: "plaid" });
    }
  },

  async getTransactions(userId, opts) {
    const creds = getCreds();
    if (!creds) {
      return fail<Transaction[]>("not_supported", "Plaid isn't configured (set PLAID_CLIENT_ID / PLAID_SECRET).", {
        provider: "plaid",
        retryable: false,
      });
    }
    const accessToken = await getPlaidAccessToken(userId);
    if (!accessToken) {
      return fail<Transaction[]>("auth_expired", "No linked bank account — connect one to see transactions.", {
        provider: "plaid",
        retryable: false,
      });
    }

    const days = Math.min(730, Math.max(1, opts?.days ?? 30));
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    try {
      const res = await fetch(`${plaidHost(creds.env)}/transactions/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: accessToken,
          start_date: start.toISOString().slice(0, 10),
          end_date: end.toISOString().slice(0, 10),
          options: { count: 250, offset: 0 },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(9_000),
      });
      if (!res.ok) {
        return failFromStatus<Transaction[]>(res.status, "Plaid transactions request failed.", { provider: "plaid" });
      }
      const data = (await res.json()) as { transactions?: RawPlaidTransaction[] };
      return ok(normalizeTransactions(data.transactions ?? [], { provider: "plaid" }));
    } catch (e) {
      return failFromException<Transaction[]>(e, "Failed to fetch Plaid transactions.", { provider: "plaid" });
    }
  },

  async getLiabilities(userId) {
    const creds = getCreds();
    if (!creds) {
      return fail<Liability[]>("not_supported", "Plaid isn't configured (set PLAID_CLIENT_ID / PLAID_SECRET).", {
        provider: "plaid",
        retryable: false,
      });
    }
    const accessToken = await getPlaidAccessToken(userId);
    if (!accessToken) {
      return fail<Liability[]>("auth_expired", "No linked bank account — connect one to see liabilities.", {
        provider: "plaid",
        retryable: false,
      });
    }
    try {
      const res = await fetch(`${plaidHost(creds.env)}/liabilities/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, access_token: accessToken }),
        cache: "no-store",
        signal: AbortSignal.timeout(9_000),
      });
      if (!res.ok) {
        return failFromStatus<Liability[]>(res.status, "Plaid liabilities request failed.", { provider: "plaid" });
      }
      const data = (await res.json()) as { accounts?: RawPlaidAccount[]; liabilities?: RawLiabilities };
      // Build the account_id -> summary map the pure normalizer joins against.
      const accountsById: Record<string, AccountSummary> = {};
      for (const a of data.accounts ?? []) {
        if (a.account_id) {
          accountsById[a.account_id] = {
            name: a.name,
            balanceCurrent: a.balances?.current ?? null,
            currency: a.balances?.iso_currency_code ?? "USD",
          };
        }
      }
      return ok(normalizeLiabilities(data.liabilities ?? {}, accountsById, { provider: "plaid" }));
    } catch (e) {
      return failFromException<Liability[]>(e, "Failed to fetch Plaid liabilities.", { provider: "plaid" });
    }
  },
};

export function resolveAccountAdapter(): AccountAdapter {
  return plaidAccountAdapter;
}
