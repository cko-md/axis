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
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";

export type Account = {
  name: string;
  mask: string | null;
  /** Plaid subtype, e.g. "checking", "savings", "credit card". */
  subtype: string | null;
  /** Plaid type, e.g. "depository", "credit", "investment". */
  type: string | null;
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceCurrentMinor: number | null;
  balanceAvailableMinor: number | null;
  currency: string;
  /** Plaid cross-Item identity; null when the institution does not support it. */
  persistentAccountId: string | null;
  provenance: Provenance;
  freshness: FreshnessTier;
};

/** The Plaid account fields the adapter extracts. */
export type RawPlaidAccount = {
  account_id?: string;
  persistent_account_id?: string | null;
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
  connectionId?: string;
  /** Reference time (defaults to now); this is the retrieval anchor. */
  now?: number;
};

/**
 * Normalize one Plaid account. Balances are a live pull, so the retrieval time
 * is the freshness anchor (a just-fetched balance is fresh against the
 * account-balance SLA). Missing currency remains unavailable; no implicit FX
 * or USD default is introduced at the provider boundary.
 */
export function normalizeAccount(raw: RawPlaidAccount, opts: NormalizeAccountOptions = {}): Account {
  const now = opts.now ?? Date.now();
  const provider = opts.provider ?? "plaid";
  const retrievedAt = new Date(now).toISOString();
  const currency = normalizeFinancialCurrency(raw.balances?.iso_currency_code, "");
  if (!currency) throw new Error("PLAID_ACCOUNT_CURRENCY_UNAVAILABLE");
  const current = exactMoneyOrNull(raw.balances?.current, currency);
  const available = exactMoneyOrNull(raw.balances?.available, currency);

  const provenance: Provenance = {
    provider,
    ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
    ...(raw.account_id ? { providerRecordId: raw.account_id } : {}),
    retrievedAt,
    currency,
  };

  return {
    name: raw.name,
    mask: raw.mask ?? null,
    subtype: raw.subtype ?? null,
    type: raw.type ?? null,
    balanceCurrent: current.major,
    balanceAvailable: available.major,
    balanceCurrentMinor: current.minor,
    balanceAvailableMinor: available.minor,
    currency,
    persistentAccountId: raw.persistent_account_id ?? null,
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

function exactMoneyOrNull(
  value: number | null | undefined,
  currency: string,
): { major: number | null; minor: number | null } {
  if (value === null || value === undefined) return { major: null, minor: null };
  const minor = strictExactMinorUnits(value, currency);
  const text = minor === null ? null : minorUnitsToDecimalString(minor, currency);
  if (minor === null || text === null) throw new Error("PLAID_ACCOUNT_AMOUNT_INVALID");
  return { major: Number(text), minor };
}
