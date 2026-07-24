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

export function isAllowedComposioTool(toolkit: SupportedToolkit, tool: string): boolean {
  return ALLOWED_COMPOSIO_TOOLS[toolkit]?.includes(tool) ?? false;
}

/**
 * The generic execute bridge is intentionally narrower than adapter
 * capabilities. Provider mutations must use the durable mutation kernel, which
 * is not present in the Phase 0 integration baseline consumed by this branch.
 */
const GENERIC_READ_ONLY_TOOLS: Readonly<Record<SupportedToolkit, readonly string[]>> = {
  gmail: [
    "GMAIL_FETCH_EMAILS",
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  ],
  outlook: [
    "OUTLOOK_LIST_MESSAGES",
    "OUTLOOK_GET_MESSAGE",
    "OUTLOOK_GET_PROFILE",
  ],
  googlecalendar: [],
  googlecontacts: [],
  strava: [],
  spotify: [],
};

export function isReadOnlyComposioTool(
  toolkit: SupportedToolkit,
  tool: string,
): boolean {
  return GENERIC_READ_ONLY_TOOLS[toolkit]?.includes(tool) ?? false;
}
