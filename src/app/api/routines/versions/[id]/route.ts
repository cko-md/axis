import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  cloneRoutineVersion,
  definitionFromJson,
  definitionToJson,
  nextRoutineVersion,
  type RoutineVersion,
} from "@/lib/routines/versioning";

type RoutineVersionRow = Database["public"]["Tables"]["routine_versions"]["Row"];

const SELECT = "id, routine_key, routine_version, name, description, definition, status, source_version_id, created_at, updated_at";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("routine_versions")
    .select(SELECT)
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "ROUTINE_VERSION_UNAVAILABLE" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ version: rowToVersion(data) });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "restore") return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });

  const { data: sourceRow, error: sourceError } = await supabase
    .from("routine_versions")
    .select(SELECT)
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (sourceError) return NextResponse.json({ error: "ROUTINE_VERSION_UNAVAILABLE" }, { status: 500 });
  if (!sourceRow) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const source = rowToVersion(sourceRow);
  const existing = await listUserVersions(supabase, user.id);
  const restored = cloneRoutineVersion(source, nextRoutineVersion(existing, source.routineKey), "active");

  const { error: archiveError } = await supabase
    .from("routine_versions")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("routine_key", source.routineKey)
    .eq("status", "active");
  if (archiveError) return NextResponse.json({ error: "ROUTINE_VERSION_RESTORE_FAILED" }, { status: 500 });

  const { data, error } = await supabase
    .from("routine_versions")
    .insert({
      user_id: user.id,
      routine_key: restored.routineKey,
      routine_version: restored.routineVersion,
      name: restored.name,
      description: restored.description,
      definition: definitionToJson(restored.definition),
      status: restored.status,
      source_version_id: restored.sourceVersionId,
    })
    .select(SELECT)
    .single();
  if (error || !data) return NextResponse.json({ error: "ROUTINE_VERSION_RESTORE_FAILED" }, { status: 500 });
  return NextResponse.json({ version: rowToVersion(data) });
}

async function listUserVersions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<RoutineVersion[]> {
  const { data } = await supabase.from("routine_versions").select(SELECT).eq("user_id", userId);
  return (data ?? []).map(rowToVersion);
}

function rowToVersion(row: Omit<RoutineVersionRow, "user_id">): RoutineVersion {
  const definition = definitionFromJson(row.definition);
  return {
    id: row.id,
    owner: "user",
    routineKey: row.routine_key,
    routineVersion: row.routine_version,
    name: row.name,
    description: row.description,
    status: row.status === "active" || row.status === "archived" ? row.status : "draft",
    definition: definition ?? {
      routineKey: row.routine_key,
      version: row.routine_version,
      title: row.name,
      description: row.description,
      inputs: {},
      steps: [],
      safety: [],
    },
    sourceVersionId: row.source_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
