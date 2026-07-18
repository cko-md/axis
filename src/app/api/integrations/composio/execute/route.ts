import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { executeTool, ComposioError, isSupportedToolkit } from "@/lib/integrations/composio";
import { isAllowedComposioTool } from "@/lib/integrations/composio-allowlist";
import { memoryRateLimit } from "@/lib/ratelimit";

interface ExecutePayload {
  toolkit?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

// POST /api/integrations/composio/execute { toolkit, tool, arguments }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rate = memoryRateLimit(`composio-execute:${user.id}`, 30, 60_000);
  if (!rate.success) {
    return NextResponse.json({ error: "Rate limit exceeded. Try again shortly." }, { status: 429 });
  }

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
  if (!isSupportedToolkit(toolkit)) {
    return NextResponse.json({ error: `Unsupported toolkit: ${toolkit}` }, { status: 400 });
  }
  if (!isAllowedComposioTool(toolkit, tool)) {
    return NextResponse.json({ error: `Tool not allowed for toolkit ${toolkit}` }, { status: 403 });
  }

  const { data: connections, error: connError } = await supabase
    .from("composio_connections")
    .select("connected_account_id, status")
    .eq("user_id", user.id)
    .eq("toolkit", toolkit)
    .eq("status", "ACTIVE");

  if (connError) {
    Sentry.captureException(connError, {
      tags: { area: "integrations", route: "/api/integrations/composio/execute", op: "list_connections" },
    });
    return NextResponse.json({ error: "Could not load Composio connection" }, { status: 503 });
  }

  const connection = connections?.[0];
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
    if (!result.successful) {
      Sentry.captureException(new Error("Composio tool execution was unsuccessful"), {
        tags: { area: "integrations", route: "/api/integrations/composio/execute", op: "execute_tool", toolkit, tool, code: "provider_error" },
      });
      return NextResponse.json(
        { successful: false, error: "Composio tool execution failed." },
        { status: 502 },
      );
    }
    return NextResponse.json({
      successful: true,
      error: null,
    });
  } catch (err) {
    const status = err instanceof ComposioError ? err.status : 502;
    Sentry.captureException(err instanceof Error ? err : new Error("Composio execute failed"), {
      tags: { area: "integrations", route: "/api/integrations/composio/execute", toolkit, tool },
    });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Tool execution failed" }, { status });
  }
}
