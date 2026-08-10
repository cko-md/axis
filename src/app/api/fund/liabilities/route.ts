import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactMinorUnits,
  strictScaledUnits,
} from "@/lib/fund/financialTruth";
import { validateLiabilityCoverage } from "@/lib/fund/liabilityTruth";

const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];
const MAX_MONEY = 1_000_000_000_000;

function parseMoney(value: unknown, field: string, currency: string, options?: { nullable?: boolean }) {
  if (options?.nullable && (value === null || value === "" || value === undefined)) return { value: null };
  const minor = strictExactMinorUnits(value, currency);
  const exact = minor === null ? null : minorUnitsToDecimalString(minor, currency);
  if (minor === null || minor < 0 || !exact || Number(exact) > MAX_MONEY) {
    return { error: `INVALID_${field.toUpperCase()}` };
  }
  return { value: exact as unknown as number };
}

function parseDueDate(value: unknown) {
  if (value === null || value === "" || value === undefined) return { value: null };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { value };
  return { error: "INVALID_DUE_DATE" };
}

async function authenticate() {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/fund/liabilities", area: "fund" });
  if (!identity.ok) return { response: NextResponse.json({ error: identity.code }, { status: identity.status }) };
  return { supabase: identity.client, user: identity.user };
}

function parseRate(value: unknown) {
  if (value === null || value === "" || value === undefined) return { value: null };
  const scaled = strictScaledUnits(value, 1_000_000);
  const exact = scaled === null ? null : scaledUnitsToDecimalString(scaled, 1_000_000);
  if (scaled === null || scaled < 0 || scaled > 100_000_000 || !exact) return { error: "INVALID_APR" };
  return { value: exact as unknown as number };
}

export async function GET(request: NextRequest) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth;
  const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  if (expectedSubject && expectedSubject !== profileSubjectForUserId(user.id)) {
    return NextResponse.json({ error: "SUBJECT_CHANGED" }, { status: 409 });
  }

  const [
    { data, error },
    { data: coverage, error: coverageError },
    { data: connections, error: connectionsError },
  ] = await Promise.all([
    supabase
      .from("fund_liabilities")
      .select("id, name, kind, balance, apr, minimum_payment, due_date, currency, source, authority, retrieved_at, provider, provider_record_id, connection_id, generation_id, reconciliation_state")
      .eq("user_id", user.id)
      .in("authority", ["manual", "provider"])
      .order("balance", { ascending: false }),
    supabase
      .from("fund_provider_coverage")
      .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason, generation_id, generation_hash")
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .eq("component", "liabilities")
      .limit(33),
    supabase
      .from("fund_connections")
      .select("id, provider, status, authority, verified_at")
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .limit(33),
  ]);

  if (error) return redactRouteError(error, { route: "fund/liabilities", area: "fund" });
  if (coverageError) return redactRouteError(coverageError, { route: "fund/liabilities", area: "fund" });
  if (connectionsError) return redactRouteError(connectionsError, { route: "fund/liabilities", area: "fund" });
  if ((coverage ?? []).length > 32 || (connections ?? []).length > 32) {
    return NextResponse.json({ error: "LIABILITY_COVERAGE_UNAVAILABLE", reason: "COVERAGE_VERIFICATION_LIMIT_EXCEEDED" }, { status: 409 });
  }
  const allRows = data ?? [];
  const providerRows = allRows.filter((row) => row.authority === "provider");
  const providerUnavailableReason = validateLiabilityCoverage(providerRows, connections ?? [], coverage ?? []);
  const liabilities = allRows.filter((row) =>
    row.authority === "manual" || (row.authority === "provider" && providerUnavailableReason === null),
  );
  return NextResponse.json(
    {
      liabilities,
      providerAvailability: coverage ?? [],
      providerUnavailable: providerUnavailableReason !== null,
      providerUnavailableReason,
      withheldProviderCount: providerUnavailableReason === null ? 0 : providerRows.length,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth;
  const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  if (expectedSubject && expectedSubject !== profileSubjectForUserId(user.id)) {
    return NextResponse.json({ error: "SUBJECT_CHANGED" }, { status: 409 });
  }

  const parsedBody = await readBoundedJsonBody(request, 8_192);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const kind = typeof body.kind === "string" && KINDS.includes(body.kind) ? body.kind : null;
  const currency = normalizeFinancialCurrency(body.currency, "");
  if (!currency || !kind || !name || name.length > 256) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const balance = parseMoney(body.balance, "balance", currency);
  const apr = parseRate(body.apr);
  const minimumPayment = parseMoney(body.minimum_payment, "minimum_payment", currency, { nullable: true });
  const dueDate = parseDueDate(body.due_date);
  const firstError = balance.error ?? apr.error ?? minimumPayment.error ?? dueDate.error;
  if (firstError) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("fund_liabilities")
    .insert({
      user_id: user.id,
      name,
      kind,
      balance: balance.value as number, // validated non-null above (balance.error → 400)
      apr: apr.value,
      minimum_payment: minimumPayment.value,
      due_date: dueDate.value,
      source: "manual",
      authority: "manual",
      currency,
    })
    .select()
    .single();

  if (error) return redactRouteError(error, { route: "fund/liabilities", area: "fund" });
  return NextResponse.json({ liability: data });
}
