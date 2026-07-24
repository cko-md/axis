import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateEventPatch, type ScheduleEventPatchInput } from "@/lib/calendar/event-detail";
import { readBoundedJson } from "@/lib/http/boundedJson";

function requestIdempotencyKey(req: NextRequest) {
  const value = req.headers.get("idempotency-key");
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 32_000) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const body = await readBoundedJson(req, 32_000).catch(() => null) as ScheduleEventPatchInput | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const validated = validateEventPatch(body);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: validated.status });
  // Provider identifiers are server-only after the authority lockdown. Retain
  // the established UX contract (external updates are unsupported) without
  // returning either identifier to the browser.
  const admin = createAdminClient();
  const notSupported: Array<"google" | "outlook"> = [];
  let authorityLookupFailed = !admin;
  if (admin) {
    const { data: linked, error: linkedError } = await admin
      .from("schedule_events")
      .select("gcal_event_id,outlook_event_id")
      .eq("id", id).eq("user_id", user.id)
      .maybeSingle();
    if (linkedError) {
      authorityLookupFailed = true;
      Sentry.captureException(new Error("Schedule provider authority lookup failed"), {
        tags: { area: "calendar", route: "/api/calendar/event/[id]", op: "lookup_provider_authority" },
      });
    } else if (!linked) {
      authorityLookupFailed = true;
    } else {
      if (linked.gcal_event_id) notSupported.push("google");
      if (linked.outlook_event_id) notSupported.push("outlook");
    }
  }
  if (authorityLookupFailed) {
    return NextResponse.json({ error: "Calendar provider authority could not be verified; no local change was made." }, { status: 503 });
  }
  if (notSupported.length > 0) {
    return NextResponse.json({ error: "External calendar events are read-only until provider update reconciliation is available." }, { status: 422 });
  }
  const { data, error } = await supabase
    .from("schedule_events")
    .update({ ...validated.patch, updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", user.id)
    .select("id,title,description,start_at,end_at,color_class,all_day")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not update event" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  return NextResponse.json({
    event: data,
    partial: authorityLookupFailed,
    errors: [],
    notSupported,
    ...(authorityLookupFailed ? { warning: "The local event was saved, but calendar connection state could not be verified." } : {}),
  });
}

// Local events can be deleted through the protected RPC. External calendar
// deletes are deliberately unavailable until atomic cohort preparation and a
// verified provider-absence reconciler are ready; no tombstone or provider call
// is created on that path.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const idempotencyKey = requestIdempotencyKey(req);
  if (!idempotencyKey) return NextResponse.json({ error: "A valid Idempotency-Key header is required" }, { status: 422 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "The protected mutation service is unavailable. Nothing was deleted." }, { status: 503 });
  const { data: event, error } = await admin
    .from("schedule_events")
    .select("id,title,start_at,end_at,gcal_event_id,outlook_event_id,deleted_at,external_cleanup_state")
    .eq("id", eventId).eq("user_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not load event" }, { status: 500 });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  if (event.external_cleanup_state === "confirmed") {
    return NextResponse.json({ ok: true, state: "succeeded", partial: false, calendarCleanupFailed: false });
  }
  if (event.deleted_at || event.external_cleanup_state !== "active") {
    return NextResponse.json({
      ok: false,
      state: "reconciliation_required",
      partial: true,
      calendarCleanupFailed: true,
      error: "This calendar deletion is already pending provider reconciliation. Do not retry it.",
    }, { status: 202 });
  }

  if (!event.gcal_event_id && !event.outlook_event_id) {
    const { data: deletion, error: deleteError } = await admin.rpc("delete_local_schedule_event", { p_user_id: user.id, p_event_id: eventId });
    if (deleteError) return NextResponse.json({ error: "Could not delete event" }, { status: 500 });
    const outcome = deletion && typeof deletion === "object" && !Array.isArray(deletion)
      ? (deletion as { outcome?: unknown }).outcome
      : null;
    if (outcome === "calendar_creation_linked") {
      return NextResponse.json({
        error: "Calendar creation outcome is pending; nothing was deleted.",
        state: "reconciliation_required",
      }, { status: 409 });
    }
    if (outcome !== "deleted") return NextResponse.json({ error: "Could not delete event" }, { status: 500 });
    return NextResponse.json({ ok: true, state: "succeeded", partial: false, calendarCleanupFailed: false });
  }

  return NextResponse.json({
    error: "External calendar deletion is temporarily unavailable while provider verification is completed. Nothing was deleted.",
    state: "failed_before_dispatch",
  }, { status: 422 });
}
