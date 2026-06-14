/**
 * Plaid credential and host helpers — shared across plaid routes.
 * Extracted here so that route.ts files only export valid HTTP verb handlers.
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
