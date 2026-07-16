import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  getOrCreateAuthConfig,
  initiateConnection,
  isSupportedToolkit,
  CUSTOM_AUTH_TOOLKITS,
  ComposioError,
  deleteConnectedAccount,
} from "@/lib/integrations/composio";

// Toolkits in CUSTOM_AUTH_TOOLKITS need our own OAuth client registered with
// Composio (it doesn't manage their auth) — map each to the env vars that
// hold those credentials. googlecontacts reuses the same Google OAuth app the
// legacy direct Contacts flow already uses (src/app/api/contacts/connect/
// route.ts); spotify reuses the same Spotify app the legacy direct flow uses
// (src/app/api/spotify/auth/route.ts) — same SPOTIFY_CLIENT_ID/SECRET.
const CUSTOM_AUTH_ENV: Record<string, { clientId?: string; clientSecret?: string }> = {
  googlecontacts: { clientId: optionalEnv("GOOGLE_CLIENT_ID"), clientSecret: optionalEnv("GOOGLE_CLIENT_SECRET") },
  spotify: { clientId: optionalEnv("SPOTIFY_CLIENT_ID"), clientSecret: optionalEnv("SPOTIFY_CLIENT_SECRET") },
};

// gmail/outlook intentionally allow multiple connected mailboxes (see
// mail_connections' composite key). Every other toolkit is single-account in
// this app's design — but Composio issues a FRESH connected_account_id on
// every OAuth grant, and the DB's unique constraint is
// (user_id, toolkit, connected_account_id), so the upsert below can never
// match an existing row on reconnect. Left unhandled, every reconnect (e.g.
// after a token expired, or just retrying) silently piled up a duplicate
// ACTIVE row — which duplicated every calendar event, Strava activity, etc.
// in any UI that lists "all active connections" for the toolkit. Revoke prior
// rows for single-account toolkits before recording the new one.
const MULTI_ACCOUNT_TOOLKITS = new Set(["gmail", "outlook"]);

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

  const callbackUrl = `${getAppOrigin(req)}/oauth-done?provider=composio_${toolkit}`;

  const needsCustomAuth = (CUSTOM_AUTH_TOOLKITS as readonly string[]).includes(toolkit);
  if (needsCustomAuth) {
    const creds = CUSTOM_AUTH_ENV[toolkit];
    if (!creds?.clientId || !creds?.clientSecret) {
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error`));
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

    // Revoke any prior connection(s) for this single-account toolkit now that
    // the new grant is confirmed in-flight — never before, so a failed
    // initiateConnection above never leaves the user with nothing connected.
    if (!MULTI_ACCOUNT_TOOLKITS.has(toolkit)) {
      const { data: staleRows } = await supabase
        .from("composio_connections")
        .select("id, connected_account_id")
        .eq("user_id", user.id)
        .eq("toolkit", toolkit)
        .neq("connected_account_id", connectedAccountId);
      if (staleRows && staleRows.length > 0) {
        const revocations = await Promise.allSettled(
          staleRows.map((row) => deleteConnectedAccount(row.connected_account_id)),
        );
        const revokedRowIds = staleRows.flatMap((row, index) =>
          revocations[index]?.status === "fulfilled" ? [row.id] : [],
        );
        const failedCount = staleRows.length - revokedRowIds.length;

        if (failedCount > 0) {
          captureRouteError(new Error("One or more stale Composio connections could not be revoked"), {
            route: "/api/integrations/composio/connect",
            operation: "revoke_stale_connections",
            area: "integrations",
            provider: "composio",
            status: 502,
            code: "PARTIAL_REVOCATION",
            tags: { toolkit, failed_count: failedCount, stale_count: staleRows.length },
          });
        }

        if (revokedRowIds.length > 0) {
          await supabase
            .from("composio_connections")
            .delete()
            .eq("user_id", user.id)
            .in("id", revokedRowIds);
        }

        if (failedCount > 0) {
          const partialUrl = new URL(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=partial`));
          partialUrl.searchParams.set("revoked", String(revokedRowIds.length));
          partialUrl.searchParams.set("failed", String(failedCount));
          return NextResponse.redirect(partialUrl);
        }
      }
    }

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
      captureRouteError(dbError, {
        route: "/api/integrations/composio/connect",
        operation: "upsert_connection",
        area: "integrations",
        provider: "supabase",
        status: 500,
      });
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error`));
    }

    if (!redirectUrl) {
      captureRouteError(new Error("Composio returned no redirect URL"), {
        route: "/api/integrations/composio/connect",
        operation: "initiate_connection",
        area: "integrations",
        provider: "composio",
        status: 502,
        code: "NO_REDIRECT_URL",
        tags: { toolkit },
      });
      return NextResponse.redirect(buildAppUrl(req, `/oauth-done?provider=composio_${toolkit}&status=error`));
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
