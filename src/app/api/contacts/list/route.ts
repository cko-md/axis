import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getContactsTokens } from "@/lib/contacts/tokens";

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

export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const tokens = await getContactsTokens(user.id);
  if (!tokens) return NextResponse.json({ error: "Not connected" }, { status: 401 });

  const res = await fetch(
    "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=100",
    { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
  );

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 502 });
  }

  const data = await res.json() as GoogleConnectionsResponse;
  const connections: GooglePerson[] = data.connections ?? [];

  const contacts: ContactEntry[] = connections.map((person) => ({
    id: person.resourceName ?? crypto.randomUUID(),
    name: person.names?.[0]?.displayName ?? "",
    email: person.emailAddresses?.[0]?.value ?? "",
    phone: person.phoneNumbers?.[0]?.value ?? "",
  }));

  return NextResponse.json(contacts);
}
