/**
 * Plaid account domain model — the normalized, provenance-aware account shape,
 * independent of Plaid's payload (§10 provider→domain boundary). Brings linked
 * bank/brokerage balances into the provenance/freshness kernel (§4) so the UI
 * can show how fresh a balance is.
 *
 * Normalization is pure and unit-tested; the impure adapter (adapter.ts) fetches
 * from Plaid and hands raw accounts here.
 */

import {
  classifyFreshness,
  FRESHNESS_SLAS,
  type FreshnessTier,
  type Provenance,
} from "@/lib/fund/provenance";

export type Account = {
  name: string;
  mask: string | null;
  /** Plaid subtype, e.g. "checking", "savings", "credit card". */
  subtype: string | null;
  /** Plaid type, e.g. "depository", "credit", "investment". */
  type: string | null;
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  currency: string;
  provenance: Provenance;
  freshness: FreshnessTier;
};

/** The Plaid account fields the adapter extracts. */
export type RawPlaidAccount = {
  account_id?: string;
  name: string;
  mask?: string | null;
  subtype?: string | null;
  type?: string | null;
  balances?: {
    current?: number | null;
    available?: number | null;
    iso_currency_code?: string | null;
  } | null;
};

export type NormalizeAccountOptions = {
  provider?: string;
  /** Reference time (defaults to now); this is the retrieval anchor. */
  now?: number;
};

/**
 * Normalize one Plaid account. Balances are a live pull, so the retrieval time
 * is the freshness anchor (a just-fetched balance is fresh against the
 * account-balance SLA). Currency comes from the account, defaulting to USD.
 */
export function normalizeAccount(raw: RawPlaidAccount, opts: NormalizeAccountOptions = {}): Account {
  const now = opts.now ?? Date.now();
  const provider = opts.provider ?? "plaid";
  const retrievedAt = new Date(now).toISOString();
  const currency = raw.balances?.iso_currency_code ?? "USD";

  const provenance: Provenance = { provider, retrievedAt, currency };

  return {
    name: raw.name,
    mask: raw.mask ?? null,
    subtype: raw.subtype ?? null,
    type: raw.type ?? null,
    balanceCurrent: numOrNull(raw.balances?.current),
    balanceAvailable: numOrNull(raw.balances?.available),
    currency,
    provenance,
    freshness: classifyFreshness(retrievedAt, FRESHNESS_SLAS.accountBalance, now),
  };
}

export function normalizeAccounts(
  raws: RawPlaidAccount[],
  opts: NormalizeAccountOptions = {},
): Account[] {
  return raws.map((r) => normalizeAccount(r, opts));
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
