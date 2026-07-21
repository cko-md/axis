// Mail adapter resolution. API routes call `resolveMailAdapter(account)` then
// invoke generic methods — they never name a provider or transport. Adapters
// are stateless singletons; per-call account context is built via `toMailContext`.

import type { MailProvider, MailAccountRef } from "../tokens";
import type { IntegrationErrorCode } from "../../integrations/types";
import type { MailAdapter } from "./types";
import { gmailComposioAdapter } from "./gmail-composio";
import { outlookComposioAdapter } from "./outlook-composio";

export * from "./types";

// Mail is Composio-only: the direct-OAuth adapters were removed after the
// Mail/Calendar/Contacts consolidation (every mailbox connects via Composio).
const ADAPTERS: Record<MailProvider, MailAdapter> = {
  gmail: gmailComposioAdapter,
  outlook: outlookComposioAdapter,
};

export function resolveMailAdapter(provider: MailProvider): MailAdapter {
  return ADAPTERS[provider];
}

/** Convenience: resolve straight from a unified account ref. */
export function adapterForAccount(account: MailAccountRef): MailAdapter {
  return resolveMailAdapter(account.provider);
}

/** Map a normalized error code to the HTTP status an API route should return. */
export function mailErrorStatus(code: IntegrationErrorCode): number {
  switch (code) {
    case "auth_expired": return 401;
    case "invalid_request": return 400;
    case "not_found": return 404;
    case "rate_limited": return 429;
    case "not_supported": return 501;
    case "provider_error":
    case "network":
    case "unknown":
    default:
      return 502;
  }
}
