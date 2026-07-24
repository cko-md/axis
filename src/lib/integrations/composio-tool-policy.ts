import type { SupportedToolkit } from "./composio";

/**
 * Server-side least-privilege policy for the verified dispatch boundary.
 * Browser allowlists are deliberately not authority: every internal caller is
 * checked here too, so an accidental tool slug cannot become a deputy path.
 */
export const VERIFIED_COMPOSIO_READ_TOOLS: Record<SupportedToolkit, readonly string[]> = {
  // Keep these explicit. Positional array slices silently widen authority when
  // a provider registry is reordered or extended with a mutation.
  gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"],
  outlook: ["OUTLOOK_LIST_MESSAGES", "OUTLOOK_GET_MESSAGE", "OUTLOOK_LIST_EVENTS"],
  googlecalendar: [
    "GOOGLECALENDAR_EVENTS_LIST",
    "GOOGLECALENDAR_FREE_BUSY_QUERY",
    "GOOGLECALENDAR_FIND_FREE_SLOTS",
    "GOOGLECALENDAR_LIST_CALENDARS",
  ],
  googlecontacts: ["GOOGLECONTACTS_LIST_CONNECTIONS"],
  strava: ["STRAVA_GET_AUTHENTICATED_ATHLETE", "STRAVA_LIST_ATHLETE_ACTIVITIES"],
  spotify: [],
};

export function isVerifiedComposioReadTool(toolkit: SupportedToolkit, toolSlug: string): boolean {
  return VERIFIED_COMPOSIO_READ_TOOLS[toolkit].includes(toolSlug);
}
