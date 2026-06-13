import { NextResponse } from "next/server";

/**
 * Brokerage (Public.com) connectivity status. Generic scaffold behind a
 * setup-state, matching /api/massive/status and /api/plaid/status. Returns
 * { configured: false } with no error when keys are absent so the order
 * ticket can route to local-log mode and show a "Connect Public" prompt.
 */
export function getBrokerageCreds() {
  const apiKey = process.env.PUBLIC_API_KEY || process.env.BROKERAGE_API_KEY;
  const accountId =
    process.env.PUBLIC_ACCOUNT_ID || process.env.BROKERAGE_ACCOUNT_ID;
  if (!apiKey) return null;
  return { apiKey, accountId: accountId ?? null };
}

export async function GET() {
  const creds = getBrokerageCreds();
  return NextResponse.json({
    configured: !!creds,
    provider: "public",
    message: creds
      ? "Brokerage (Public.com) is configured server-side."
      : "Add PUBLIC_API_KEY to enable order routing through Public.com. Orders are logged locally until then.",
  });
}
