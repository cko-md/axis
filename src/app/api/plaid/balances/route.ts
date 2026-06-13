import { NextRequest, NextResponse } from "next/server";
import { getPlaidCreds, plaidHost } from "../status/route";

/**
 * Fetches account balances for a linked Plaid item.
 *
 * Without keys: returns { configured: false } (200) so the Cash panel renders
 * a calm "connect a bank" empty-state rather than throwing.
 *
 * With keys: exchanges the body access_token for balances. The access_token is
 * passed from the server-held connection record — never exposed to the client
 * beyond this proxy boundary.
 */
export async function POST(request: NextRequest) {
  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json({
      configured: false,
      accounts: [],
      message:
        "Add PLAID_CLIENT_ID and PLAID_SECRET to pull live bank balances.",
    });
  }

  let accessToken: string | undefined;
  try {
    const body = await request.json();
    accessToken = body?.access_token;
  } catch {
    // no body
  }

  if (!accessToken) {
    return NextResponse.json(
      { configured: true, error: "MISSING_ACCESS_TOKEN" },
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
      const detail = await res.text();
      return NextResponse.json(
        { configured: true, error: "PLAID_BALANCES_FAILED", detail },
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
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { configured: true, error: "PLAID_BALANCES_FAILED", message },
      { status: 502 },
    );
  }
}
