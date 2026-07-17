import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  BUILTIN_ROUTINE_VERSIONS,
  cloneRoutineVersion,
  definitionFromJson,
  definitionToJson,
  getBuiltinRoutineVersion,
  nextRoutineVersion,
  type RoutineVersion,
} from "@/lib/routines/versioning";

type RoutineVersionRow = Database["public"]["Tables"]["routine_versions"]["Row"];

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("routine_versions")
    .select("id, routine_key, routine_version, name, description, definition, status, source_version_id, created_at, updated_at")
    .eq("user_id", user.id)
    .order("routine_key", { ascending: true })
    .order("routine_version", { ascending: true });
  if (error) return NextResponse.json({ error: "ROUTINE_VERSIONS_UNAVAILABLE" }, { status: 500 });

  return NextResponse.json({ versions: [...BUILTIN_ROUTINE_VERSIONS, ...(data ?? []).map(rowToVersion)] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { action?: string; sourceId?: string };
  if (body.action !== "clone" || !body.sourceId) {
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  }

  const source = await resolveVersion(supabase, user.id, body.sourceId);
  if (!source) return NextResponse.json({ error: "SOURCE_VERSION_NOT_FOUND" }, { status: 404 });

  const existing = await listUserVersions(supabase, user.id);
  const cloned = cloneRoutineVersion(source, nextRoutineVersion([...BUILTIN_ROUTINE_VERSIONS, ...existing], source.routineKey), "draft");

  const { data, error } = await supabase
    .from("routine_versions")
    .insert({
      user_id: user.id,
      routine_key: cloned.routineKey,
      routine_version: cloned.routineVersion,
      name: cloned.name,
      description: cloned.description,
      definition: definitionToJson(cloned.definition),
      status: cloned.status,
      source_version_id: cloned.sourceVersionId,
    })
    .select("id, routine_key, routine_version, name, description, definition, status, source_version_id, created_at, updated_at")
    .single();
  if (error || !data) return NextResponse.json({ error: "ROUTINE_VERSION_CLONE_FAILED" }, { status: 500 });
  return NextResponse.json({ version: rowToVersion(data) }, { status: 201 });
}

async function resolveVersion(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  id: string,
): Promise<RoutineVersion | null> {
  const builtin = getBuiltinRoutineVersion(id);
  if (builtin) return builtin;
  const { data, error } = await supabase
    .from("routine_versions")
    .select("id, routine_key, routine_version, name, description, definition, status, source_version_id, created_at, updated_at")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return rowToVersion(data);
}

async function listUserVersions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<RoutineVersion[]> {
  const { data } = await supabase
    .from("routine_versions")
    .select("id, routine_key, routine_version, name, description, definition, status, source_version_id, created_at, updated_at")
    .eq("user_id", userId);
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
