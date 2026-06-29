// Composio-backed Google Contacts, mirroring src/lib/mail/composio.ts.
// Additive alongside the legacy direct-OAuth path (src/lib/contacts/tokens.ts
// + /api/contacts/{connect,callback}) — contacts synced this way are merged
// into the same list the legacy path returns.
//
// googlecontacts is a CUSTOM_AUTH_TOOLKIT (see src/lib/integrations/
// composio.ts) — Composio doesn't manage its OAuth app, so Axis registers
// its own (reusing GOOGLE_CLIENT_ID/SECRET, the same app the legacy flow
// already uses). It also has no profile tool that reliably returns the
// connected account's own email, so its account_label is always the static
// "Google Contacts" placeholder set by resolveProfileLabel.
//
// NOTE: tool slug AND input argument schema confirmed live against
// Composio's /tools/{slug} endpoint. Response shape is carried over from the
// legacy integration's known-good Google People API shape (same `names`/
// `emailAddresses`/`phoneNumbers` fields /api/contacts/list/route.ts already
// parses) since Composio's contacts tools wrap that same API — lower risk
// than Calendar's guesses, but still unconfirmed against a live connection.
import { createClient } from "@/lib/supabase/server";
import { executeTool } from "@/lib/integrations/composio";

const LIST_TOOL = "GOOGLECONTACTS_LIST_CONNECTIONS";

export type ComposioContactsAccount = {
  provider: "googlecontacts";
  via: "composio";
  connectedAccountId: string;
};

export async function listComposioContactsAccounts(userId: string): Promise<ComposioContactsAccount[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("composio_connections")
    .select("connected_account_id")
    .eq("user_id", userId)
    .eq("toolkit", "googlecontacts")
    .eq("status", "ACTIVE");

  return (data ?? []).map((row) => ({
    provider: "googlecontacts" as const,
    via: "composio" as const,
    connectedAccountId: row.connected_account_id as string,
  }));
}

export type ComposioContact = {
  id: string;
  name: string;
  email: string;
  phone: string;
};

function normalizePerson(p: Record<string, unknown>): ComposioContact {
  const names = p.names as Array<{ displayName?: string }> | undefined;
  const emails = p.emailAddresses as Array<{ value?: string }> | undefined;
  const phones = p.phoneNumbers as Array<{ value?: string }> | undefined;
  return {
    id: (p.resourceName as string) ?? crypto.randomUUID(),
    name: names?.[0]?.displayName ?? "",
    email: emails?.[0]?.value ?? "",
    phone: phones?.[0]?.value ?? "",
  };
}

export async function listComposioContacts(connectedAccountId: string, userId: string): Promise<ComposioContact[]> {
  const res = await executeTool({
    toolSlug: LIST_TOOL,
    connectedAccountId,
    userId,
    arguments: { person_fields: "names,emailAddresses,phoneNumbers", page_size: 100 },
  });
  if (!res.successful) return [];
  const data = res.data as Record<string, unknown>;
  const connections = (data.connections ?? []) as Record<string, unknown>[];
  return connections.map(normalizePerson);
}
