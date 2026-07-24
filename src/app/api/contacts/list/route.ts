import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listComposioContactsAccounts, listComposioContacts } from "@/lib/contacts/composio";

export interface ContactEntry {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export type ContactsListResponse = {
  contacts: ContactEntry[];
  connected: boolean;
  via: "composio" | null;
  truncated?: boolean;
  error?: string;
};

// Contacts is Composio-only after the direct-adapter removal — the legacy
// direct-OAuth Google People read (and its token store) are gone.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ contacts: [], connected: false, via: null, error: "Unauthenticated" } satisfies ContactsListResponse, { status: 401 });
  }

  const composioAccounts = await listComposioContactsAccounts(user.id);
  if (composioAccounts.length === 0) {
    return NextResponse.json({ contacts: [], connected: false, via: null } satisfies ContactsListResponse);
  }

  const composioResults = await Promise.allSettled(
    composioAccounts.map((account) => listComposioContacts(account.connectionId, user.id)),
  );
  const contacts = composioResults.flatMap((result) => (result.status === "fulfilled" ? result.value.contacts : []));
  const composioFailed = composioResults.some((result) => result.status === "rejected");
  const truncated = composioResults.some((result) => result.status === "fulfilled" && result.value.truncated);

  return NextResponse.json({
    contacts,
    connected: true,
    via: "composio",
    truncated,
    ...(composioFailed ? { error: "Google Contacts could not be refreshed right now." } : {}),
  } satisfies ContactsListResponse);
}
