import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { getFreshContactsAccessToken } from "@/lib/contacts/tokens";
import { listComposioContactsAccounts, listComposioContacts } from "@/lib/contacts/composio";

interface GooglePerson {
  resourceName?: string;
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
}

interface GoogleConnectionsResponse {
  connections?: GooglePerson[];
}

export interface ContactEntry {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export type ContactsListResponse = {
  contacts: ContactEntry[];
  connected: boolean;
  via: "oauth" | "composio" | null;
  error?: string;
};

// Merges the legacy direct-OAuth Google Contacts connection with any
// Composio-connected one — same provider, two auth paths, same output
// shape. A user is only expected to have one of the two connected at a
// time (the picker UI doesn't offer the legacy option once Composio is
// active, and vice versa), but both are read defensively in case of overlap.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ contacts: [], connected: false, via: null, error: "Unauthenticated" } satisfies ContactsListResponse, { status: 401 });
  }

  const accessToken = await getFreshContactsAccessToken(user.id);
  let composioAccounts: Awaited<ReturnType<typeof listComposioContactsAccounts>> = [];
  let composioAccountError = false;
  try {
    composioAccounts = await listComposioContactsAccounts(user.id);
  } catch (error) {
    composioAccountError = true;
    Sentry.captureException(error instanceof Error ? error : new Error("Contacts Composio account lookup failed"), {
      tags: { module: "contacts", operation: "list_composio_accounts" },
    });
  }
  const connected = Boolean(accessToken) || composioAccounts.length > 0;

  if (!connected) {
    return NextResponse.json({ contacts: [], connected: false, via: null } satisfies ContactsListResponse);
  }

  let legacyContacts: ContactEntry[] = [];
  let legacyError = false;
  if (accessToken) {
    try {
      const res = await fetch(
        "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=100",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) throw new Error(`Google Contacts returned ${res.status}`);
      const data = await res.json() as GoogleConnectionsResponse;
      const connections: GooglePerson[] = data.connections ?? [];
      legacyContacts = connections.map((person) => ({
          id: person.resourceName ?? crypto.randomUUID(),
          name: person.names?.[0]?.displayName ?? "",
          email: person.emailAddresses?.[0]?.value ?? "",
          phone: person.phoneNumbers?.[0]?.value ?? "",
        }));
    } catch (error) {
      legacyError = true;
      Sentry.captureException(error instanceof Error ? error : new Error("Google Contacts fetch failed"), {
        tags: { module: "contacts", operation: "list_google_contacts", transport: "oauth" },
      });
    }
  }

  const composioResults = await Promise.allSettled(
    composioAccounts.map((account) => listComposioContacts(account.connectedAccountId, user.id)),
  );
  const composioContacts = composioResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const composioFailed = composioResults.some((result) => result.status === "rejected");
  if (composioFailed) {
    Sentry.captureException(new Error("One or more Composio Contacts accounts failed"), {
      tags: { module: "contacts", operation: "list_composio_contacts", transport: "composio" },
    });
  }

  const via: ContactsListResponse["via"] = composioAccounts.length > 0
    ? "composio"
    : accessToken
      ? "oauth"
      : null;

  return NextResponse.json({
    contacts: [...legacyContacts, ...composioContacts],
    connected: true,
    via,
    ...((legacyError || composioAccountError || composioFailed)
      ? { error: "Some Google Contacts could not be refreshed; the list may be incomplete." }
      : {}),
  } satisfies ContactsListResponse);
}
