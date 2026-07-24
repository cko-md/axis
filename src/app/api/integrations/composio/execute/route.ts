import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  executeTool,
  ComposioError,
  getConnectedAccount,
  isSupportedToolkit,
} from "@/lib/integrations/composio";
import {
  isAllowedComposioTool,
  isReadOnlyComposioTool,
} from "@/lib/integrations/composio-allowlist";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { readBoundedJson } from "@/lib/http/boundedJson";

const MAX_EXECUTE_BODY_BYTES = 65_536;
const MAX_ARGUMENTS_BYTES = 32_768;
const MAX_TOOLKIT_CHARS = 64;
const MAX_TOOL_CHARS = 200;
const CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ExecutePayload {
  connectionId?: string;
  toolkit?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

// POST /api/integrations/composio/execute
// { connectionId, toolkit, tool, arguments }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Must run before connection lookup or provider dispatch. Phase 1D's
  // prepare/claim/dispatch kernel consumes this same decision at its boundary.
  const admission = await admit(user.id, { ...ADMISSION_POLICIES.mutation, name: "composio-execute" });
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });
  }

  const parsedBody = await readBoundedJson(req, MAX_EXECUTE_BODY_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  const payload = parsedBody.value as ExecutePayload | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { connectionId, toolkit, tool } = payload;
  if (
    typeof connectionId !== "string"
    || !CONNECTION_ID_PATTERN.test(connectionId)
    ||
    typeof toolkit !== "string"
    || toolkit.length === 0
    || toolkit.length > MAX_TOOLKIT_CHARS
    || typeof tool !== "string"
    || tool.length === 0
    || tool.length > MAX_TOOL_CHARS
  ) {
    return NextResponse.json(
      { error: "connectionId, toolkit, and tool are required" },
      { status: 422 },
    );
  }
  if (
    payload.arguments !== undefined
    && (
      !payload.arguments
      || typeof payload.arguments !== "object"
      || Array.isArray(payload.arguments)
    )
  ) {
    return NextResponse.json({ error: "arguments must be an object" }, { status: 422 });
  }
  if (payload.arguments && new TextEncoder().encode(JSON.stringify(payload.arguments)).byteLength > MAX_ARGUMENTS_BYTES) {
    return NextResponse.json({ error: "arguments are too large" }, { status: 413 });
  }
  if (!isSupportedToolkit(toolkit)) {
    return NextResponse.json({ error: `Unsupported toolkit: ${toolkit}` }, { status: 400 });
  }
  if (!isAllowedComposioTool(toolkit, tool)) {
    return NextResponse.json({ error: `Tool not allowed for toolkit ${toolkit}` }, { status: 403 });
  }
  if (!isReadOnlyComposioTool(toolkit, tool)) {
    return NextResponse.json(
      {
        error: "MUTATION_KERNEL_REQUIRED",
        message: "Provider mutations are unavailable through the generic execute endpoint.",
      },
      { status: 409 },
    );
  }

  const { data: connection, error: connError } = await supabase
    .from("composio_connections")
    .select("connected_account_id, status")
    .eq("id", connectionId)
    .eq("user_id", user.id)
    .eq("toolkit", toolkit)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (connError) {
    captureRouteError(new Error("Composio connection lookup failed"), {
      route: "/api/integrations/composio/execute", operation: "verify_connection",
      area: "integrations", provider: "composio", status: 503, code: "CONNECTION_LOOKUP_FAILED",
    });
    return NextResponse.json({ error: "Could not load Composio connection" }, { status: 503 });
  }

  if (!connection) {
    return NextResponse.json(
      { error: "CONNECTION_NOT_VERIFIED" },
      { status: 403 },
    );
  }

  // Mandatory provider-identity stop-line: the owner-writable local mapping is
  // only a locator. Composio's live account remains authoritative for owner,
  // toolkit, and ACTIVE state before any provider tool can dispatch.
  let remoteConnection;
  try {
    remoteConnection = await getConnectedAccount(
      connection.connected_account_id,
    );
  } catch {
    captureRouteError(new Error("Composio identity verification failed"), {
      route: "/api/integrations/composio/execute",
      operation: "verify_provider_identity",
      area: "integrations",
      provider: "composio",
      status: 503,
      code: "PROVIDER_IDENTITY_UNAVAILABLE",
      tags: { toolkit },
    });
    return NextResponse.json(
      { error: "PROVIDER_IDENTITY_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (
    remoteConnection.id !== connection.connected_account_id
    || remoteConnection.user_id !== user.id
    || remoteConnection.toolkit?.slug !== toolkit
    || remoteConnection.status !== "ACTIVE"
  ) {
    return NextResponse.json(
      { error: "CONNECTION_NOT_VERIFIED" },
      { status: 403 },
    );
  }

  try {
    const result = await executeTool({
      toolSlug: tool,
      connectedAccountId: connection.connected_account_id,
      userId: user.id,
      arguments: payload.arguments,
    });
    if (result.successful !== true) {
      captureRouteError(new Error("Composio provider operation failed"), {
        route: "/api/integrations/composio/execute",
        operation: "execute_tool",
        area: "integrations",
        provider: "composio",
        status: 502,
        code: "PROVIDER_OPERATION_FAILED",
        tags: { toolkit, tool },
      });
      return NextResponse.json(
        { successful: false, error: "PROVIDER_OPERATION_FAILED" },
        { status: 502 },
      );
    }
    return NextResponse.json({ successful: true, error: null });
  } catch (err) {
    const status = err instanceof ComposioError ? err.status : 502;
    captureRouteError(new Error("Composio execution failed"), {
      route: "/api/integrations/composio/execute", operation: "execute_tool",
      area: "integrations", provider: "composio", status, code: "PROVIDER_OPERATION_FAILED",
      tags: { toolkit, tool },
    });
    return NextResponse.json({ error: "PROVIDER_OPERATION_FAILED" }, { status });
  }
}
