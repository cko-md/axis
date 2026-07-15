/**
 * Plaid liability domain model — normalized, provenance-aware (§10). Plaid's
 * /liabilities/get splits detail across credit/student/mortgage arrays that
 * reference an `account_id`; the balance lives on the account. This joins them
 * into one domain Liability per account, with provenance + freshness.
 *
 * Normalization is pure and unit-tested; the adapter does the fetch/join.
 */

import { parseMoney } from "@/lib/fund/money";
import {
  classifyFreshness,
  FRESHNESS_SLAS,
  type FreshnessTier,
  type Provenance,
} from "@/lib/fund/provenance";

export type LiabilityType = "credit" | "student" | "mortgage";

export type Liability = {
  accountId: string;
  type: LiabilityType;
  name: string | null;
  /** Outstanding balance (major units, from the account), if known. */
  balanceCurrent: number | null;
  currency: string;
  lastPaymentAmount: number | null;
  nextPaymentDueDate: string | null;
  isOverdue: boolean | null;
  provenance: Provenance;
  freshness: FreshnessTier;
};

/** Account summary the join needs (built by the adapter from the accounts array). */
export type AccountSummary = {
  name?: string | null;
  balanceCurrent?: number | null;
  currency?: string | null;
};

/** The three liability arrays from /liabilities/get, minimally typed. */
export type RawLiabilities = {
  credit?: RawLiabilityEntry[] | null;
  student?: RawLiabilityEntry[] | null;
  mortgage?: RawLiabilityEntry[] | null;
};

export type RawLiabilityEntry = {
  account_id: string;
  last_payment_amount?: number | null;
  next_payment_due_date?: string | null;
  is_overdue?: boolean | null;
};

export type NormalizeLiabilityOptions = {
  provider?: string;
  now?: number;
};

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? parseMoney(v) : null;
}

/**
 * Normalize the /liabilities/get payload into domain Liabilities, joining each
 * entry to its account (by account_id) for name/balance/currency.
 */
export function normalizeLiabilities(
  raw: RawLiabilities,
  accountsById: Record<string, AccountSummary>,
  opts: NormalizeLiabilityOptions = {},
): Liability[] {
  const now = opts.now ?? Date.now();
  const provider = opts.provider ?? "plaid";
  const retrievedAt = new Date(now).toISOString();

  const out: Liability[] = [];
  const types: LiabilityType[] = ["credit", "student", "mortgage"];
  for (const type of types) {
    for (const entry of raw[type] ?? []) {
      const acct = accountsById[entry.account_id] ?? {};
      const currency = acct.currency ?? "USD";
      out.push({
        accountId: entry.account_id,
        type,
        name: acct.name ?? null,
        balanceCurrent: numOrNull(acct.balanceCurrent),
        currency,
        lastPaymentAmount: numOrNull(entry.last_payment_amount),
        nextPaymentDueDate: entry.next_payment_due_date ?? null,
        isOverdue: entry.is_overdue ?? null,
        provenance: { provider, providerRecordId: entry.account_id, retrievedAt, currency },
        freshness: classifyFreshness(retrievedAt, FRESHNESS_SLAS.accountBalance, now),
      });
    }
  }
  return out;
}
