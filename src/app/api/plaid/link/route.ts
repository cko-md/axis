import { NextResponse } from "next/server";
import { getPlaidCreds, plaidHost } from "../status/route";

/**
 * Creates a Plaid Link token. Degrades gracefully: with no keys it returns a
 * 503 setup-state ({ configured: false }) so the client can show a
 * "Connect bank via Plaid" prompt instead of erroring.
 */
export async function POST() {
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
        user: { client_user_id: "axis-user" },
        products: ["transactions"],
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { configured: true, error: "PLAID_LINK_FAILED", detail },
        { status: 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json({
      configured: true,
      link_token: data.link_token,
      expiration: data.expiration,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { configured: true, error: "PLAID_LINK_FAILED", message },
      { status: 502 },
    );
  }
}
