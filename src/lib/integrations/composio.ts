// Server-only Composio client. Composio holds the actual OAuth tokens for each
// connected toolkit (Gmail, Outlook, etc.) — we only ever store the toolkit
// name + Composio's `connected_account_id` + status, mapped 1:1 to our
// Supabase `auth.users.id` as Composio's `user_id`. Real API host (verified
// live): backend.composio.dev — NOT api.composio.dev, which doesn't resolve.
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";

// Toolkits the app's connect/execute routes will broker. Extend as more
// domains (calendar, contacts, spotify, ...) migrate onto Composio.
export const SUPPORTED_TOOLKITS = ["gmail", "outlook"] as const;
export type SupportedToolkit = (typeof SUPPORTED_TOOLKITS)[number];
export function isSupportedToolkit(v: string): v is SupportedToolkit {
  return (SUPPORTED_TOOLKITS as readonly string[]).includes(v);
}

export class ComposioError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY;
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
// connect to a toolkit. We lazily create one Composio-managed auth_config per
// toolkit (no client_id/secret of ours required — Composio brokers the OAuth
// app itself) and reuse it for every user.
export async function getOrCreateAuthConfig(toolkitSlug: string): Promise<string> {
  const existing = await composioFetch<{ items: ComposioAuthConfig[] }>(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=10`,
  );
  const reusable = existing.items.find((c) => c.is_composio_managed);
  if (reusable) return reusable.id;

  const created = await composioFetch<{ auth_config: { id: string } }>(`/auth_configs`, {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug: toolkitSlug },
      auth_config: { type: "use_composio_managed_auth", name: `axis-${toolkitSlug}` },
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
export async function initiateConnection(opts: {
  toolkitSlug: string;
  authConfigId: string;
  userId: string;
  callbackUrl: string;
}): Promise<InitiateConnectionResult> {
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
