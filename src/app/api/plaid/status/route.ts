import { NextResponse } from "next/server";

/**
 * Plaid connectivity status. Mirrors /api/massive/status: returns a clean
 * "not configured" setup-state when PLAID_CLIENT_ID / PLAID_SECRET are unset,
 * so the UI can render a "Connect bank via Plaid" affordance with no errors.
 */
export function getPlaidCreds() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || "sandbox";
  if (!clientId || !secret) return null;
  return { clientId, secret, env };
}

export function plaidHost(env: string) {
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

export async function GET() {
  const creds = getPlaidCreds();
  return NextResponse.json({
    configured: !!creds,
    provider: "plaid",
    env: creds?.env ?? null,
    message: creds
      ? "Plaid is configured server-side."
      : "Add PLAID_CLIENT_ID and PLAID_SECRET to enable bank linking via Plaid.",
  });
}
