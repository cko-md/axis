import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";

const VALID_STATUS = ["active", "cancelled", "irregular"];

/** PATCH /api/fund/recurring/:id — confirm or cancel a detected recurring charge. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/fund/recurring/[id]", area: "fund" });
  if (!identity.ok) return NextResponse.json({ error: identity.code }, { status: identity.status });
  const { client: supabase, user } = identity;

  const { id } = await params;
  const parsedBody = await readBoundedJsonBody(request, 2_048);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  if (typeof body.status !== "string" || !VALID_STATUS.includes(body.status)) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("fund_recurring_transactions")
    .update({ status: body.status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return redactRouteError(error, { route: "fund/recurring/[id]", area: "fund" });
  return NextResponse.json({ recurring: data });
}
