import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";
import { getPlaidAccessToken } from "@/lib/fund/plaidTokens";

/**
 * Fetches account balances for the authenticated user's linked Plaid item.
 *
 * Without keys: returns { configured: false } (200) so the Cash panel renders
 * a calm "connect a bank" empty-state rather than throwing.
 *
 * With keys: looks up the access_token from the server-side Supabase record
 * keyed by the authenticated user.id — the client never supplies it.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json({
      configured: false,
      accounts: [],
      message:
        "Add PLAID_CLIENT_ID and PLAID_SECRET to pull live bank balances.",
    });
  }

  // Retrieve the stored access_token from the server-side record for this user.
  // The client must never supply the token directly.
  const accessToken = await getPlaidAccessToken(user.id);

  if (!accessToken) {
    return NextResponse.json(
      { configured: true, error: "NO_LINKED_ACCOUNT" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${plaidHost(creds.env)}/accounts/balance/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId,
        secret: creds.secret,
        access_token: accessToken,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      // Log detail server-side; return only a sanitized code to the client.
      const detail = await res.text();
      console.error("[plaid/balances] upstream error:", detail);
      return NextResponse.json(
        { configured: true, error: "PLAID_BALANCES_FAILED" },
        { status: 502 },
      );
    }

    const data = await res.json();
    const accounts = (data.accounts ?? []).map(
      (a: {
        name: string;
        mask?: string;
        subtype?: string;
        balances?: { current?: number; available?: number };
      }) => ({
        name: a.name,
        mask: a.mask ?? null,
        subtype: a.subtype ?? null,
        current: a.balances?.current ?? null,
        available: a.balances?.available ?? null,
      }),
    );
    return NextResponse.json({ configured: true, accounts });
  } catch {
    return NextResponse.json(
      { configured: true, error: "PLAID_BALANCES_FAILED" },
      { status: 502 },
    );
  }
}
