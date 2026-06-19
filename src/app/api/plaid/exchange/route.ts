import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";

/**
 * Exchanges a Plaid public_token for a server-side access_token and stores it
 * in plaid_items keyed by user_id.  The access_token is NEVER returned to the
 * client.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    public_token?: string;
    institution?: string | null;
  };
  if (!body.public_token)
    return NextResponse.json({ error: "Missing public_token" }, { status: 400 });

  const creds = getPlaidCreds();
  if (!creds)
    return NextResponse.json({ error: "Plaid not configured" }, { status: 503 });

  const exchangeRes = await fetch(
    `${plaidHost(creds.env)}/item/public_token/exchange`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId,
        secret: creds.secret,
        public_token: body.public_token,
      }),
    },
  );

  if (!exchangeRes.ok) {
    const err = (await exchangeRes.json().catch(() => ({}))) as {
      error_message?: string;
    };
    return NextResponse.json(
      { error: err.error_message ?? "Token exchange failed" },
      { status: 502 },
    );
  }

  const plaidData = (await exchangeRes.json()) as {
    access_token: string;
    item_id: string;
  };
  const { access_token, item_id } = plaidData;

  await supabase.from("plaid_items").upsert(
    {
      user_id: user.id,
      access_token,
      item_id,
      institution_name: body.institution ?? null,
    },
    { onConflict: "user_id" },
  );

  return NextResponse.json({ ok: true });
}
