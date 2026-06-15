/**
 * Brokerage (Public.com) credential helpers — shared across brokerage routes.
 * Extracted here so that route.ts files only export valid HTTP verb handlers.
 */
export function getBrokerageCreds() {
  const apiKey =
    process.env.APP_PUBLIC_API_KEY ||
    process.env.PUBLIC_API_KEY ||
    process.env.BROKERAGE_API_KEY;
  const accountId =
    process.env.APP_PUBLIC_ACCOUNT_ID ||
    process.env.PUBLIC_ACCOUNT_ID ||
    process.env.BROKERAGE_ACCOUNT_ID;
  if (!apiKey) return null;
  return { apiKey, accountId: accountId ?? null };
}
