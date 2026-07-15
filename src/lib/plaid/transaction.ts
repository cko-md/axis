/**
 * Plaid transaction domain model — normalized, provenance-aware, provider-
 * independent (§10). Feeds the Activity module and ties transactions into the
 * provenance kernel. Amount convention matches the rest of the app: positive =
 * inflow (Plaid reports positive = debit, so it is negated), cent-exact via the
 * money primitive.
 *
 * Normalization is pure and unit-tested; the adapter does the fetch.
 */

import { parseMoney } from "@/lib/fund/money";
import {
  classifyFreshness,
  FRESHNESS_SLAS,
  type FreshnessTier,
  type Provenance,
} from "@/lib/fund/provenance";

export type Transaction = {
  id: string;
  name: string;
  merchantName: string | null;
  /** Major units; positive = inflow (Plaid's sign is flipped). */
  amount: number;
  /** Posted date, YYYY-MM-DD. */
  date: string;
  pending: boolean;
  currency: string;
  provenance: Provenance;
  freshness: FreshnessTier;
};

export type RawPlaidTransaction = {
  transaction_id: string;
  name: string;
  merchant_name?: string | null;
  amount: number;
  date: string;
  authorized_date?: string | null;
  pending?: boolean;
  iso_currency_code?: string | null;
};

export type NormalizeTransactionOptions = {
  provider?: string;
  now?: number;
};

/** Normalize one Plaid transaction into the domain shape with provenance. */
export function normalizeTransaction(
  raw: RawPlaidTransaction,
  opts: NormalizeTransactionOptions = {},
): Transaction {
  const now = opts.now ?? Date.now();
  const provider = opts.provider ?? "plaid";
  const currency = raw.iso_currency_code ?? "USD";
  const retrievedAt = new Date(now).toISOString();

  const provenance: Provenance = {
    provider,
    providerRecordId: raw.transaction_id,
    retrievedAt,
    // The transaction's own date is its effective date.
    ...(raw.date ? { effectiveAt: raw.date } : {}),
    currency,
  };

  return {
    id: raw.transaction_id,
    name: raw.name,
    merchantName: raw.merchant_name ?? null,
    amount: parseMoney(-raw.amount), // flip: positive = inflow, cent-exact
    date: raw.date,
    pending: raw.pending ?? false,
    currency,
    provenance,
    freshness: classifyFreshness(retrievedAt, FRESHNESS_SLAS.accountBalance, now),
  };
}

export function normalizeTransactions(
  raws: RawPlaidTransaction[],
  opts: NormalizeTransactionOptions = {},
): Transaction[] {
  return raws.map((r) => normalizeTransaction(r, opts));
}
