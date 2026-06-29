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

interface ContactEntry {
  id: string;
  name: string;
  email: string;
  phone: string;
}

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
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const accessToken = await getFreshContactsAccessToken(user.id);

  let legacyContacts: ContactEntry[] = [];
  if (accessToken) {
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

  const composioAccounts = await listComposioContactsAccounts(user.id);
  const composioContacts = (
    await Promise.all(
      composioAccounts.map((a) => listComposioContacts(a.connectedAccountId, user.id).catch(() => [])),
    )
  ).flat();

  if (!accessToken && composioAccounts.length === 0) {
    return NextResponse.json({ error: "Not connected" }, { status: 401 });
  }

  return NextResponse.json([...legacyContacts, ...composioContacts]);
}
