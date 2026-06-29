import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import {
  getOrCreateAuthConfig,
  initiateConnection,
  isSupportedToolkit,
  CUSTOM_AUTH_TOOLKITS,
  ComposioError,
} from "@/lib/integrations/composio";

// Toolkits in CUSTOM_AUTH_TOOLKITS need our own OAuth client registered with
// Composio (it doesn't manage their auth) — map each to the env vars that
// hold those credentials. googlecontacts reuses the same Google OAuth app the
// legacy direct Contacts flow already uses (src/app/api/contacts/connect/
// route.ts); spotify reuses the same Spotify app the legacy direct flow uses
// (src/app/api/spotify/auth/route.ts) — same SPOTIFY_CLIENT_ID/SECRET.
const CUSTOM_AUTH_ENV: Record<string, { clientId?: string; clientSecret?: string }> = {
  googlecontacts: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
  spotify: { clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET },
};

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

  const needsCustomAuth = (CUSTOM_AUTH_TOOLKITS as readonly string[]).includes(toolkit);
  if (needsCustomAuth) {
    const creds = CUSTOM_AUTH_ENV[toolkit];
    if (!creds?.clientId || !creds?.clientSecret) {
      return NextResponse.json({ error: "Composio is not configured" }, { status: 503 });
    }
  }

  try {
    const authConfigId = needsCustomAuth
      ? await getOrCreateAuthConfig(toolkit, {
          clientId: CUSTOM_AUTH_ENV[toolkit].clientId!,
          clientSecret: CUSTOM_AUTH_ENV[toolkit].clientSecret!,
        })
      : await getOrCreateAuthConfig(toolkit);
    const { connectedAccountId, redirectUrl, status } = await initiateConnection({
      toolkitSlug: toolkit,
      authConfigId,
      userId: user.id,
      callbackUrl,
      composioManaged: !needsCustomAuth,
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
