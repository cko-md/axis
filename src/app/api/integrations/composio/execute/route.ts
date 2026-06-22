import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeTool, ComposioError } from "@/lib/integrations/composio";

interface ExecutePayload {
  toolkit?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

// POST /api/integrations/composio/execute { toolkit, tool, arguments }
// Generic tool-execution bridge: looks up this user's ACTIVE connected
// account for `toolkit` and calls `tool` on it. Any module that has migrated
// to Composio (Mail today; calendar/contacts/spotify/etc. later) calls
// through this single route rather than each owning its own token plumbing.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: ExecutePayload;
  try {
    payload = (await req.json()) as ExecutePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 422 });
  }

  const { toolkit, tool } = payload;
  if (!toolkit || !tool) {
    return NextResponse.json({ error: "toolkit and tool are required" }, { status: 422 });
  }

  const { data: connection } = await supabase
    .from("composio_connections")
    .select("connected_account_id, status")
    .eq("user_id", user.id)
    .eq("toolkit", toolkit)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (!connection) {
    return NextResponse.json({ error: `No active Composio connection for ${toolkit}` }, { status: 403 });
  }

  try {
    const result = await executeTool({
      toolSlug: tool,
      connectedAccountId: connection.connected_account_id,
      userId: user.id,
      arguments: payload.arguments,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof ComposioError ? err.status : 502;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Tool execution failed" }, { status });
  }
}
