// Shared calendar types. `ExternalCalendarEvent` is the normalized shape every
// calendar source produces; it used to live in the (now removed) direct-OAuth
// google.ts client and is consumed by the Composio calendar adapter and routes.
export type ExternalCalendarEvent = {
  externalId: string;
  title: string;
  start_at: string;
  end_at: string;
  description?: string | null;
  location?: string | null;
  attendees?: string[];
  all_day: boolean;
};
