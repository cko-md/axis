import { NextResponse } from "next/server";
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
  const composioAccounts = await listComposioContactsAccounts(user.id);
  const connected = Boolean(accessToken) || composioAccounts.length > 0;

  if (!connected) {
    return NextResponse.json({ contacts: [], connected: false, via: null } satisfies ContactsListResponse);
  }

  let legacyContacts: ContactEntry[] = [];
  // Composio wins: skip the legacy direct-OAuth Google Contacts read entirely
  // when a Composio contacts account exists, so a stale legacy token can neither
  // double-list nor shadow the Composio result. Legacy is read only when there
  // is no Composio account. (Prod has zero legacy rows and no path writes them.)
  if (accessToken && composioAccounts.length === 0) {
    const res = await fetch(
      "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=100",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) {
      const data = await res.json() as GoogleConnectionsResponse;
      const connections: GooglePerson[] = data.connections ?? [];
      legacyContacts = connections.map((person) => ({
        id: person.resourceName ?? crypto.randomUUID(),
        name: person.names?.[0]?.displayName ?? "",
        email: person.emailAddresses?.[0]?.value ?? "",
        phone: person.phoneNumbers?.[0]?.value ?? "",
      }));
    }
  }

  const composioResults = await Promise.allSettled(
    composioAccounts.map((account) => listComposioContacts(account.connectedAccountId, user.id)),
  );
  const composioContacts = composioResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const composioFailed = composioResults.some((result) => result.status === "rejected");

  const via: ContactsListResponse["via"] = composioAccounts.length > 0
    ? "composio"
    : accessToken
      ? "oauth"
      : null;

  return NextResponse.json({
    contacts: [...legacyContacts, ...composioContacts],
    connected: true,
    via,
    ...(composioFailed && composioContacts.length === 0 && legacyContacts.length === 0
      ? { error: "Google Contacts could not be refreshed right now." }
      : {}),
  } satisfies ContactsListResponse);
}
