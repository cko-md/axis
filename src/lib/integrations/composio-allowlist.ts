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
