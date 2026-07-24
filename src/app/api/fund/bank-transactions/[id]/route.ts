import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";

const PATCHABLE = [
  "custom_category",
  "tags",
  "excluded_from_budget",
  "reviewed",
  "notes",
] as const;

const CATEGORY_RE = /^[A-Z0-9_ -]{1,80}$/;

function buildPatch(body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};

  if ("custom_category" in body) {
    if (body.custom_category === null || body.custom_category === "") {
      patch.custom_category = null;
    } else if (typeof body.custom_category === "string" && CATEGORY_RE.test(body.custom_category.trim())) {
      patch.custom_category = body.custom_category.trim().toUpperCase().replace(/\s+/g, "_");
    } else {
      return { error: "INVALID_CATEGORY" };
    }
  }

  if ("tags" in body) {
    if (body.tags === null) {
      patch.tags = null;
    } else if (Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string" && tag.length <= 40)) {
      patch.tags = body.tags.slice(0, 12).map((tag) => tag.trim()).filter(Boolean);
    } else {
      return { error: "INVALID_TAGS" };
    }
  }

  for (const key of ["excluded_from_budget", "reviewed"] as const) {
    if (key in body) {
      if (typeof body[key] !== "boolean") return { error: "INVALID_BOOLEAN" };
      patch[key] = body[key];
    }
  }

  if ("notes" in body) {
    if (body.notes === null || body.notes === "") {
      patch.notes = null;
    } else if (typeof body.notes === "string" && body.notes.length <= 1000) {
      patch.notes = body.notes;
    } else {
      return { error: "INVALID_NOTES" };
    }
  }

  return { patch };
}

/** PATCH /api/fund/bank-transactions/:id — categorize, tag, exclude, mark reviewed. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsedBody = await readBoundedJsonBody(request, 8_192);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  const allowed = new Set<string>(PATCHABLE);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "INVALID_FIELD" }, { status: 400 });
  }
  const built = buildPatch(body);
  if (built.error) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }
  const patch = built.patch ?? {};
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "NO_VALID_FIELDS" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("fund_bank_transactions")
    .update(patch as Database["public"]["Tables"]["fund_bank_transactions"]["Update"])
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return redactRouteError(error, { route: "fund/bank-transactions/[id]", area: "fund" });
  return NextResponse.json({ transaction: data });
}
