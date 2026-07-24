import type { SupportedToolkit } from "@/lib/integrations/composio";
import { MAIL_COMPOSIO_TOOLS } from "@/lib/integrations/composio-mail-tools";

/** Composio tools permitted via /api/integrations/composio/execute per toolkit. */
export const ALLOWED_COMPOSIO_TOOLS: Record<SupportedToolkit, readonly string[]> = {
  gmail: [...MAIL_COMPOSIO_TOOLS.gmail],
  outlook: [...MAIL_COMPOSIO_TOOLS.outlook],
  googlecalendar: [],
  googlecontacts: [],
  strava: [],
  spotify: [],
};

const GENERIC_READ_ONLY_COMPOSIO_TOOLS: Record<SupportedToolkit, readonly string[]> = {
  gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"],
  outlook: ["OUTLOOK_LIST_MESSAGES", "OUTLOOK_GET_MESSAGE", "OUTLOOK_GET_PROFILE"],
  googlecalendar: [],
  googlecontacts: [],
  strava: [],
  spotify: [],
};

/**
 * The registry records every reviewed tool used by a governed domain adapter.
 * The generic execute endpoint receives only `generic_read_only`: provider
 * mutations must use the durable mutation-command kernel instead.
 */
export function isAllowedComposioTool(
  toolkit: SupportedToolkit,
  tool: string,
  scope: "registry" | "generic_read_only" = "registry",
): boolean {
  if (scope === "generic_read_only") {
    return GENERIC_READ_ONLY_COMPOSIO_TOOLS[toolkit]?.includes(tool) ?? false;
  }
  return ALLOWED_COMPOSIO_TOOLS[toolkit]?.includes(tool) ?? false;
}
