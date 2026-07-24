import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { optionalEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/** Marks abandoned claims ambiguous; it never re-dispatches a provider call. */
export async function GET(request: NextRequest) {
  const secret = optionalEnv("CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Mutation service unavailable" }, { status: 503 });
  const { data, error } = await admin.rpc("sweep_stale_provider_mutation_commands", { p_min_age_seconds: 900 });
  if (error || typeof data !== "number") {
    Sentry.captureException(error ?? new Error("Invalid mutation sweep response"), { tags: { area: "provider_mutations", op: "sweep_stale_claims" } });
    return NextResponse.json({ error: "Mutation sweep failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, markedOutcomeUnknown: data });
}
