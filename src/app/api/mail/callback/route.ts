import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { saveMailTokens, type MailProvider } from "@/lib/mail/tokens";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const saved = cookieStore.get("mail_oauth_state")?.value;

  if (!code || !state || state !== saved) {
    return NextResponse.redirect(new URL("/oauth-done?provider=mail&status=error", req.url));
  }

  const provider = state.split(":")[0] as MailProvider;
  if (provider !== "gmail" && provider !== "outlook") {
    return NextResponse.redirect(new URL("/oauth-done?provider=mail&status=error", req.url));
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const redirectUri = `${getAppOrigin(req)}/api/mail/callback`;

  let tokenData: { access_token: string; refresh_token?: string; expires_in?: number } | null = null;
  let mailEmail: string | undefined;

  if (provider === "gmail") {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) return NextResponse.redirect(new URL(`/oauth-done?provider=mail_${provider}&status=error`, req.url));
    tokenData = await res.json();

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData!.access_token}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      mailEmail = profile.email as string | undefined;
    }
  } else {
    const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "Mail.Read offline_access User.Read",
      }),
    });
    if (!res.ok) return NextResponse.redirect(new URL(`/oauth-done?provider=mail_${provider}&status=error`, req.url));
    tokenData = await res.json();

    const profileRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData!.access_token}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      mailEmail = (profile.mail ?? profile.userPrincipalName) as string | undefined;
    }
  }

  if (!tokenData?.access_token) {
    return NextResponse.redirect(new URL(`/oauth-done?provider=mail_${provider}&status=error`, req.url));
  }

  // mailEmail is required — if we couldn't determine it, refuse to save
  if (!mailEmail) {
    return NextResponse.redirect(new URL(`/oauth-done?provider=mail_${provider}&status=error`, req.url));
  }

  await saveMailTokens(
    user.id,
    provider,
    tokenData.access_token,
    tokenData.refresh_token ?? null,
    tokenData.expires_in ?? 3600,
    mailEmail,
  );

  // Delete state cookie only after successful token exchange and save
  cookieStore.delete("mail_oauth_state");

  return NextResponse.redirect(new URL(`/oauth-done?provider=mail_${provider}&status=ok`, req.url));
}
