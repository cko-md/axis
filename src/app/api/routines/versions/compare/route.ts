import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  compareRoutineVersions,
  definitionFromJson,
  getBuiltinRoutineVersion,
  type RoutineVersion,
} from "@/lib/routines/versioning";

type RoutineVersionRow = Database["public"]["Tables"]["routine_versions"]["Row"];

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { leftId?: string; rightId?: string };
  if (!body.leftId || !body.rightId) return NextResponse.json({ error: "VERSION_IDS_REQUIRED" }, { status: 400 });

  const [left, right] = await Promise.all([
    resolveVersion(supabase, user.id, body.leftId),
    resolveVersion(supabase, user.id, body.rightId),
  ]);
  if (!left || !right) return NextResponse.json({ error: "VERSION_NOT_FOUND" }, { status: 404 });

  return NextResponse.json({ diff: compareRoutineVersions(left, right), left, right });
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
