// Composio-backed Google Contacts, mirroring src/lib/mail/composio.ts.
// Additive alongside the legacy direct-OAuth path (src/lib/contacts/tokens.ts
// + /api/contacts/{connect,callback}) — contacts synced this way are merged
// into the same list the legacy path returns.
//
// googlecontacts is a CUSTOM_AUTH_TOOLKIT. Its Composio auth-config is
// owner-configured and validated before connect; request paths never create
// custom provider config from guessed credential fields.
//
// NOTE: tool slug AND input argument schema confirmed live against
// Composio's /tools/{slug} endpoint. Response shape is carried over from the
// legacy integration's known-good Google People API shape (same `names`/
// `emailAddresses`/`phoneNumbers` fields /api/contacts/list/route.ts already
// parses) since Composio's contacts tools wrap that same API — lower risk
// than Calendar's guesses, but still unconfirmed against a live connection.
import {
  executeVerifiedComposioTool,
  listAuthorizedComposioConnections,
} from "@/lib/integrations/composio-identity";

const LIST_TOOL = "GOOGLECONTACTS_LIST_CONNECTIONS";

export type ComposioContactsAccount = {
  provider: "googlecontacts";
  via: "composio";
  /** Opaque Axis-owned connection identifier. Never a Composio account id. */
  connectionId: string;
  accountLabel: string | null;
};

export async function listComposioContactsAccounts(userId: string): Promise<ComposioContactsAccount[]> {
  const connections = await listAuthorizedComposioConnections(userId, ["googlecontacts"]);
  return connections.map((connection) => ({
    provider: "googlecontacts" as const,
    via: "composio" as const,
    connectionId: connection.id,
    accountLabel: connection.accountLabel,
  }));
}

export type ComposioContact = {
  id: string;
  name: string;
  email: string;
  phone: string;
};

export class ComposioContactsReadError extends Error {
  readonly code = "contacts_provider_unavailable" as const;
  constructor() {
    super("Google Contacts could not be refreshed right now.");
  }
}

export type ComposioContactsRead = {
  contacts: ComposioContact[];
  /** The first bounded page is truthful but not a complete directory. */
  truncated: boolean;
};

function boundedString(value: unknown, max = 512): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function normalizePerson(p: Record<string, unknown>): ComposioContact | null {
  const names = p.names as Array<{ displayName?: string }> | undefined;
  const emails = p.emailAddresses as Array<{ value?: string }> | undefined;
  const phones = p.phoneNumbers as Array<{ value?: string }> | undefined;
  const id = boundedString(p.resourceName, 512);
  if (!id) return null;
  return {
    id,
    name: boundedString(names?.[0]?.displayName, 320) ?? "",
    email: boundedString(emails?.[0]?.value, 320) ?? "",
    phone: boundedString(phones?.[0]?.value, 64) ?? "",
  };
}

export async function listComposioContacts(connectionId: string, userId: string): Promise<ComposioContactsRead> {
  const res = await executeVerifiedComposioTool({
    toolSlug: LIST_TOOL,
    connectionId,
    toolkit: "googlecontacts",
    userId,
    arguments: { person_fields: "names,emailAddresses,phoneNumbers", page_size: 100 },
  });
  if (!res.successful || !res.data || typeof res.data !== "object" || Array.isArray(res.data)) {
    throw new ComposioContactsReadError();
  }
  const data = res.data as Record<string, unknown>;
  if (!Array.isArray(data.connections)) throw new ComposioContactsReadError();
  // The provider's page size is bounded. Do not silently claim completeness
  // when it signals a continuation that AXIS has not fetched.
  const truncated = typeof data.nextPageToken === "string" || typeof data.next_page_token === "string";
  return {
    contacts: data.connections
      .slice(0, 100)
      .filter((person): person is Record<string, unknown> => Boolean(person) && typeof person === "object" && !Array.isArray(person))
      .map(normalizePerson)
      .filter((person): person is ComposioContact => person !== null),
    truncated,
  };
}
