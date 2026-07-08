import type { SupportedToolkit } from "@/lib/integrations/composio";

/** Composio tools permitted via /api/integrations/composio/execute per toolkit. */
export const ALLOWED_COMPOSIO_TOOLS: Record<SupportedToolkit, readonly string[]> = {
  gmail: [
    "GMAIL_FETCH_EMAILS",
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_GET_MESSAGE",
    "GMAIL_SEND_EMAIL",
    "GMAIL_ADD_LABEL_TO_EMAIL",
    "GMAIL_MOVE_TO_TRASH",
  ],
  outlook: [
    "OUTLOOK_OUTLOOK_LIST_MESSAGES",
    "OUTLOOK_OUTLOOK_GET_MESSAGE",
    "OUTLOOK_OUTLOOK_SEND_EMAIL",
  ],
  googlecalendar: [],
  googlecontacts: [],
  strava: [],
  spotify: [],
};

export function isAllowedComposioTool(toolkit: SupportedToolkit, tool: string): boolean {
  return ALLOWED_COMPOSIO_TOOLS[toolkit]?.includes(tool) ?? false;
}
