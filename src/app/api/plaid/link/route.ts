import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";

/**
 * Creates a Plaid Link token for the authenticated user. Degrades gracefully:
 * with no keys it returns a 503 setup-state ({ configured: false }) so the
 * client can show a "Connect bank via Plaid" prompt instead of erroring.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json(
      {
        configured: false,
        error: "PLAID_NOT_CONFIGURED",
        message:
          "Set PLAID_CLIENT_ID and PLAID_SECRET to enable bank linking via Plaid.",
      },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(`${plaidHost(creds.env)}/link/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId,
        secret: creds.secret,
        client_name: "Axis · Fund",
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: user.id },
        products: ["transactions"],
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      // Log detail server-side; return only a sanitized code to the client.
      const detail = await res.text();
      console.error("[plaid/link] upstream error:", detail);
      return NextResponse.json(
        { configured: true, error: "PLAID_LINK_FAILED" },
        { status: 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json({
      configured: true,
      link_token: data.link_token,
      expiration: data.expiration,
    });
  } catch {
    return NextResponse.json(
      { configured: true, error: "PLAID_LINK_FAILED" },
      { status: 502 },
    );
  }
}
