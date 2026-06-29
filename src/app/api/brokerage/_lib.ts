import { getBrokerageAccountId, getBrokerageApiKey } from "@/lib/env";

/**
 * Brokerage (Public.com) credential helpers — shared across brokerage routes.
 * Extracted here so that route.ts files only export valid HTTP verb handlers.
 */
export function getBrokerageCreds() {
  const apiKey = getBrokerageApiKey();
  const accountId = getBrokerageAccountId();
  if (!apiKey) return null;
  return { apiKey, accountId: accountId ?? null };
}
