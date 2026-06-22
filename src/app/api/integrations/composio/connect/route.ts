import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import {
  getOrCreateAuthConfig,
  initiateConnection,
  isSupportedToolkit,
  ComposioError,
} from "@/lib/integrations/composio";

// GET /api/integrations/composio/connect?toolkit=gmail|outlook
// Mirrors /api/mail/connect's shape (a popup-friendly redirect) so it can be
// opened with the existing openOAuthPopup() helper.
export async function GET(req: NextRequest) {
  const toolkit = req.nextUrl.searchParams.get("toolkit") ?? "";
  if (!isSupportedToolkit(toolkit)) {
    return NextResponse.json({ error: `Unsupported toolkit: ${toolkit}` }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const callbackUrl = `${getAppOrigin(req)}/oauth-done?provider=composio_${toolkit}&status=ok`;

  try {
    const authConfigId = await getOrCreateAuthConfig(toolkit);
    const { connectedAccountId, redirectUrl, status } = await initiateConnection({
      toolkitSlug: toolkit,
      authConfigId,
      userId: user.id,
      callbackUrl,
    });

    const { error: dbError } = await supabase.from("composio_connections").upsert(
      {
        user_id: user.id,
        toolkit,
        connected_account_id: connectedAccountId,
        auth_config_id: authConfigId,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,toolkit,connected_account_id" },
    );
    // If we can't record the pending connection, don't send the user through
    // an OAuth flow our status/execute routes will never be able to find.
    if (dbError) {
      return NextResponse.redirect(new URL(`/oauth-done?provider=composio_${toolkit}&status=error`, req.url));
    }

    if (!redirectUrl) {
      return NextResponse.redirect(new URL(`/oauth-done?provider=composio_${toolkit}&status=error`, req.url));
    }
    return NextResponse.redirect(redirectUrl);
  } catch (err) {
    const status = err instanceof ComposioError ? err.status : 500;
    if (status === 503) {
      return NextResponse.json({ error: "Composio is not configured" }, { status: 503 });
    }
    return NextResponse.redirect(new URL(`/oauth-done?provider=composio_${toolkit}&status=error`, req.url));
  }
}
