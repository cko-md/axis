import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  getOrCreateAuthConfig,
  initiateConnection,
  isSupportedToolkit,
  CUSTOM_AUTH_TOOLKITS,
  ComposioError,
  getPrivateConnectedAccountExact,
  assertAuthConfigToolkit,
} from "@/lib/integrations/composio";
import { assertRemoteBinding } from "@/lib/integrations/composio-identity";

// Custom credentials are configured and validated in the Composio dashboard.
// Do not create a custom auth config in a user request: v3.1 requires an
// auth-scheme-specific body and required-field discovery, and a guessed body
// can leave an orphaned provider resource. These ids are server-only config.
const CUSTOM_AUTH_CONFIG_ENV: Record<string, string | undefined> = {
  googlecontacts: optionalEnv("COMPOSIO_GOOGLECONTACTS_AUTH_CONFIG_ID"),
  spotify: optionalEnv("COMPOSIO_SPOTIFY_AUTH_CONFIG_ID"),
};

function isTrustedComposioRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (url.port === "" || url.port === "443")
      && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
}

// GET /api/integrations/composio/connect?toolkit=gmail|outlook
// Mirrors /api/mail/connect's shape (a popup-friendly redirect) so it can be
// opened with the existing openOAuthPopup() helper.
export async function GET(req: NextRequest) {
  const toolkit = req.nextUrl.searchParams.get("toolkit") ?? "";
  if (!isSupportedToolkit(toolkit)) {
    return NextResponse.json({ error: `Unsupported toolkit: ${toolkit}` }, { status: 400 });
  }
  // Opening an OAuth popup from AXIS is same-origin. Reject a cross-site
  // navigation before it can create a provider-side link session.
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site provider initiation is not allowed" }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Connection authority is unavailable." }, { status: 503 });

  const connectionId = crypto.randomUUID();
  const callbackUrl = `${getAppOrigin(req)}/oauth-done?provider=composio_${toolkit}&attempt=${encodeURIComponent(connectionId)}`;

  const needsCustomAuth = (CUSTOM_AUTH_TOOLKITS as readonly string[]).includes(toolkit);
  if (needsCustomAuth) {
    if (!CUSTOM_AUTH_CONFIG_ENV[toolkit]) {
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error`));
    }
  }

  try {
    const authConfigId = needsCustomAuth
      ? CUSTOM_AUTH_CONFIG_ENV[toolkit]!
      : await getOrCreateAuthConfig(toolkit);
    await assertAuthConfigToolkit(authConfigId, toolkit);
    const { connectedAccountId, redirectUrl, status } = await initiateConnection({
      toolkitSlug: toolkit,
      authConfigId,
      userId: user.id,
      callbackUrl,
      composioManaged: !needsCustomAuth,
    });

    const remote = await getPrivateConnectedAccountExact({
      toolkit,
      userId: user.id,
      authConfigId,
      connectedAccountId,
      // Managed link sessions report INITIATED; custom OAuth currently
      // reports INITIALIZING. Never require ACTIVE before the callback.
      status: null,
    });
    assertRemoteBinding({
      user_id: user.id,
      toolkit,
      connected_account_id: connectedAccountId,
      auth_config_id: authConfigId,
    }, remote, { requireActive: false });
    if (!["INITIATED", "INITIALIZING", "PENDING"].includes(remote.status)) {
      throw new ComposioError("Composio connection initiation state was not accepted", 403);
    }

    const { error: dbError } = await admin.rpc("axis_create_composio_connection_authority", {
      p_connection_id: connectionId,
      p_user_id: user.id,
      p_toolkit: toolkit,
      p_connected_account_id: connectedAccountId,
      p_auth_config_id: authConfigId,
      p_status: status,
      p_account_label: null,
    });
    if (dbError) {
      captureRouteError(dbError, {
        route: "/api/integrations/composio/connect",
        operation: "upsert_connection",
        area: "integrations",
        provider: "supabase",
        status: 500,
      });
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error&attempt=${connectionId}`));
    }

    if (!redirectUrl || !isTrustedComposioRedirect(redirectUrl)) {
      captureRouteError(new Error("Composio returned no redirect URL"), {
        route: "/api/integrations/composio/connect",
        operation: "initiate_connection",
        area: "integrations",
        provider: "composio",
        status: 502,
        code: "NO_REDIRECT_URL",
        tags: { toolkit },
      });
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error&attempt=${connectionId}`));
    }
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    const status = err instanceof ComposioError ? err.status : 500;
    if (status === 503) {
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error`));
    }
    captureRouteError(err, {
      route: "/api/integrations/composio/connect",
      operation: "initiate_connection",
      area: "integrations",
      provider: "composio",
      status,
      tags: { toolkit },
    });
    return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error`));
  }
}
