import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/fund/holdings/[id]", area: "fund" });
  if (!identity.ok) return NextResponse.json({ error: identity.code }, { status: identity.status });
  const { client: supabase, user } = identity;
  const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  if (expectedSubject && expectedSubject !== profileSubjectForUserId(user.id)) {
    return NextResponse.json({ error: "SUBJECT_CHANGED" }, { status: 409 });
  }

  const { id } = await params;
  const { error } = await supabase.from("fund_holdings").delete().eq("id", id).eq("user_id", user.id);
  if (error) return redactRouteError(error, { route: "fund/holdings/[id]", area: "fund" });
  return NextResponse.json({ ok: true });
}
