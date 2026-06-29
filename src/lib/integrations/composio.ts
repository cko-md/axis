// Server-only Composio client. Composio holds the actual OAuth tokens for each
// connected toolkit (Gmail, Outlook, etc.) — we only ever store the toolkit
// name + Composio's `connected_account_id` + status, mapped 1:1 to our
// Supabase `auth.users.id` as Composio's `user_id`. Real API host (verified
// live): backend.composio.dev — NOT api.composio.dev, which doesn't resolve.
import { optionalEnv } from "@/lib/env";

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";

// Toolkits the app's connect/execute routes will broker. Extend as more
// domains (calendar, contacts, spotify, strava, ...) migrate onto Composio.
// strava/spotify added as secondary (Composio) connect paths alongside their
// existing direct-OAuth implementations — see useStrava.ts / src/app/api/
// spotify — which stay primary since they're deeply integrated (token
// refresh, playback control, library/search) well beyond what a generic
// toolkit bridge replaces in one pass.
export const SUPPORTED_TOOLKITS = ["gmail", "outlook", "googlecalendar", "googlecontacts", "strava", "spotify"] as const;
export type SupportedToolkit = (typeof SUPPORTED_TOOLKITS)[number];
export function isSupportedToolkit(v: string): v is SupportedToolkit {
  return (SUPPORTED_TOOLKITS as readonly string[]).includes(v);
}

// Toolkits Composio does not manage OAuth for — we must register our own
// OAuth client (client_id/secret) as a "custom auth" auth_config. Verified
// live against backend.composio.dev/api/v3/toolkits/<slug> on 2026-06-27:
// googlecalendar/outlook/gmail/strava have composio_managed_auth_schemes
// non-empty (Composio brokers its own OAuth app); googlecontacts and spotify
// have it empty (composio_managed_auth_schemes: []) — Composio requires our
// own client_id/secret for those, registered as a use_custom_auth auth_config.
export const CUSTOM_AUTH_TOOLKITS = ["googlecontacts", "spotify"] as const;

export class ComposioError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getApiKey(): string {
  const key = optionalEnv("COMPOSIO_API_KEY");
  if (!key) throw new ComposioError("COMPOSIO_API_KEY is not configured", 503);
  return key;
}

async function composioFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": getApiKey(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ComposioError(`Composio ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ComposioToolkit = {
  slug: string;
  name: string;
  auth_schemes: string[];
  composio_managed_auth_schemes: string[];
  meta?: { logo?: string; description?: string; tools_count?: number };
};

export async function listToolkits(limit = 50): Promise<ComposioToolkit[]> {
  const data = await composioFetch<{ items: ComposioToolkit[] }>(`/toolkits?limit=${limit}`);
  return data.items;
}

export type ComposioAuthConfig = {
  id: string;
  toolkit?: { slug: string };
  is_composio_managed?: boolean;
};

// Composio requires an auth_config (the OAuth "app" record) before a user can
// connect to a toolkit. For most toolkits we lazily create one Composio-
// managed auth_config (no client_id/secret of ours required — Composio
// brokers the OAuth app itself) and reuse it for every user. A few toolkits
// (CUSTOM_AUTH_TOOLKITS) don't offer managed auth, so the caller must pass
// `custom` — our own OAuth client credentials — and we register those as a
// "use_custom_auth" auth_config instead.
//
// NOTE: the use_custom_auth request shape below (credentials.client_id/
// client_secret nested under auth_config) is our best read of Composio's API
// — it was not exercised against a live POST during implementation (doing so
// would have meant putting a real client_secret on a command line). Verify
// it against a real call the first time a googlecontacts connect is tested.
export async function getOrCreateAuthConfig(
  toolkitSlug: string,
  custom?: { clientId: string; clientSecret: string },
): Promise<string> {
  const existing = await composioFetch<{ items: ComposioAuthConfig[] }>(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=10`,
  );
  const reusable = existing.items.find((c) => (custom ? !c.is_composio_managed : c.is_composio_managed));
  if (reusable) return reusable.id;

  const created = await composioFetch<{ auth_config: { id: string } }>(`/auth_configs`, {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug: toolkitSlug },
      auth_config: custom
        ? {
            type: "use_custom_auth",
            name: `axis-${toolkitSlug}`,
            credentials: { client_id: custom.clientId, client_secret: custom.clientSecret },
          }
        : { type: "use_composio_managed_auth", name: `axis-${toolkitSlug}` },
    }),
  });
  return created.auth_config.id;
}

export type InitiateConnectionResult = {
  connectedAccountId: string;
  redirectUrl: string | null;
  status: string;
};

// Starts an OAuth2 connection. `userId` is our Supabase user id, passed through
// verbatim as Composio's user_id (the mapping the foundation relies on).
//
// Composio is mid-migration on POST /connected_accounts: for Composio-managed
// OAuth1/OAuth2/DCR_OAUTH auth configs, that endpoint is retired in favor of
// POST /connected_accounts/link (new orgs cut over 2026-05-08, all orgs by
// 2026-07-03 — verified live against this org's account on 2026-06-27: a real
// Gmail connect attempt through the old endpoint sat at connected_accounts
// status EXPIRED with status_reason "Connection initiation did not complete
// within 10 minutes", which is consistent with the popup completing the
// redirect_url's hosted Composio leg but the old endpoint never actually
// wiring up the OAuth2 grant — the likely cause of "popup opens and closes
// without completing auth". Custom auth configs (our own client_id/secret —
// CUSTOM_AUTH_TOOLKITS) are explicitly unaffected per Composio's docs and
// keep using the old endpoint, which still returns a redirectUrl for them.
export async function initiateConnection(opts: {
  toolkitSlug: string;
  authConfigId: string;
  userId: string;
  callbackUrl: string;
  composioManaged: boolean;
}): Promise<InitiateConnectionResult> {
  if (opts.composioManaged) {
    const res = await composioFetch<{
      connected_account_id: string;
      redirect_url: string;
      link_token?: string;
    }>(`/connected_accounts/link`, {
      method: "POST",
      body: JSON.stringify({
        auth_config_id: opts.authConfigId,
        user_id: opts.userId,
        callback_url: opts.callbackUrl,
      }),
    });
    return {
      connectedAccountId: res.connected_account_id,
      redirectUrl: res.redirect_url ?? null,
      status: "INITIATED",
    };
  }

  const res = await composioFetch<{
    id: string;
    connectionData?: { authScheme: string; val?: { status: string; redirectUrl?: string } };
  }>(`/connected_accounts`, {
    method: "POST",
    body: JSON.stringify({
      auth_config: { id: opts.authConfigId },
      connection: {
        state: { authScheme: "OAUTH2", val: { status: "INITIALIZING" } },
        user_id: opts.userId,
        callback_url: opts.callbackUrl,
      },
    }),
  });
  return {
    connectedAccountId: res.id,
    redirectUrl: res.connectionData?.val?.redirectUrl ?? null,
    status: res.connectionData?.val?.status ?? "INITIALIZING",
  };
}

export type ConnectedAccount = {
  id: string;
  status: string;
  toolkit?: { slug: string };
};

export async function getConnectedAccount(connectedAccountId: string): Promise<ConnectedAccount> {
  return composioFetch<ConnectedAccount>(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
}

export async function deleteConnectedAccount(connectedAccountId: string): Promise<void> {
  await composioFetch<void>(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`, { method: "DELETE" });
}

export type ToolExecuteResult = {
  successful: boolean;
  data: unknown;
  error?: string | null;
};

export async function executeTool(opts: {
  toolSlug: string;
  connectedAccountId: string;
  userId: string;
  arguments?: Record<string, unknown>;
}): Promise<ToolExecuteResult> {
  return composioFetch<ToolExecuteResult>(`/tools/execute/${encodeURIComponent(opts.toolSlug)}`, {
    method: "POST",
    body: JSON.stringify({
      connected_account_id: opts.connectedAccountId,
      user_id: opts.userId,
      arguments: opts.arguments ?? {},
    }),
  });
}

// The tool whose response identifies *whose* account this is (almost always
// an email address), called once the first time a connection goes ACTIVE so
// the UI can show "Connected as you@example.com" instead of a bare toolkit
// name. googlecontacts has no tool that reliably returns the connected
// account's own identity, so it's handled as a special case below rather
// than through this map.
const PROFILE_TOOL: Partial<Record<SupportedToolkit, string>> = {
  gmail: "GMAIL_GET_PROFILE",
  outlook: "OUTLOOK_OUTLOOK_GET_PROFILE",
  googlecalendar: "GOOGLECALENDAR_LIST_CALENDARS",
};

function firstString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "string" && v.includes("@")) return v;
  }
  return null;
}

// Best-effort label resolution, generalized across all supported toolkits
// (lifted out of the Mail-specific module it started in, since Calendar and
// Contacts need it too). googlecalendar resolves via its calendar list — the
// "primary" calendar's `id` field *is* the user's email, the standard way to
// identify whose Google Calendar this is. googlecontacts has no equivalent
// tool, so it falls back to a static label — an accepted simplification
// since a user is only expected to have one Google Contacts connection.
export async function resolveProfileLabel(
  toolkit: SupportedToolkit,
  connectedAccountId: string,
  userId: string,
): Promise<string | null> {
  if (toolkit === "googlecontacts") return "Google Contacts";
  const toolSlug = PROFILE_TOOL[toolkit];
  if (!toolSlug) return null;
  try {
    const res = await executeTool({ toolSlug, connectedAccountId, userId });
    if (!res.successful) return null;
    if (toolkit === "googlecalendar") {
      const data = res.data as Record<string, unknown>;
      const items = (data.items ?? []) as Record<string, unknown>[];
      const primary = items.find((c) => c.primary === true) ?? items[0];
      return firstString(primary, ["id"]);
    }
    return firstString(res.data, ["emailAddress", "email", "mail", "userPrincipalName"]);
  } catch {
    return null;
  }
}
