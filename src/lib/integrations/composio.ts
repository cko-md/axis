import "server-only";
// Server-only Composio client. Composio holds the actual OAuth tokens for each
// connected toolkit (Gmail, Outlook, etc.) — we only ever store the toolkit
// name + Composio's `connected_account_id` + status, mapped 1:1 to our
// Supabase `auth.users.id` as Composio's `user_id`. Real API host (verified
// live): backend.composio.dev — NOT api.composio.dev, which doesn't resolve.
import { optionalEnv } from "@/lib/env";

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
const COMPOSIO_V31_BASE = "https://backend.composio.dev/api/v3.1";
const MAX_COMPOSIO_RESPONSE_BYTES = 256 * 1024;

async function boundedJson<T>(res: Response): Promise<T> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_COMPOSIO_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new ComposioError("Composio response exceeded the safe size limit", 502);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new ComposioError("Composio returned an empty response body", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_COMPOSIO_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ComposioError("Composio response exceeded the safe size limit", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new ComposioError("Composio returned invalid JSON", 502);
  }
}

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
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    // Provider responses can contain OAuth diagnostics and account data. Keep
    // the error safe for route responses and Sentry; status/path metadata is
    // enough for observability and callers must never surface the body.
    await res.body?.cancel().catch(() => undefined);
    throw new ComposioError(`Composio request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return boundedJson<T>(res);
}

async function composioV31Fetch<T>(path: string): Promise<T> {
  const res = await fetch(`${COMPOSIO_V31_BASE}${path}`, {
    headers: { "x-api-key": getApiKey() },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ComposioError(`Composio request failed (${res.status})`, res.status);
  }
  return boundedJson<T>(res);
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
// (CUSTOM_AUTH_TOOLKITS) don't offer managed auth. AXIS does not create those
// configurations at request time: Composio v3.1 custom credentials require a
// toolkit-specific auth scheme and required-field discovery, so guessing a
// generic payload would be an unsafe provider-side effect. They must use an
// owner-configured auth-config id created and validated in the Composio
// dashboard instead (see custom-auth-configs documentation).
export async function getOrCreateAuthConfig(
  toolkitSlug: string,
): Promise<string> {
  if ((CUSTOM_AUTH_TOOLKITS as readonly string[]).includes(toolkitSlug)) {
    throw new ComposioError("Custom auth requires an owner-configured Composio auth config", 503);
  }
  const existing = await composioFetch<{ items: ComposioAuthConfig[] }>(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=10`,
  );
  const reusable = existing.items.find((c) => c.toolkit?.slug === toolkitSlug && c.is_composio_managed);
  if (reusable) return reusable.id;

  const created = await composioFetch<{ auth_config: { id: string } }>(`/auth_configs`, {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug: toolkitSlug },
      auth_config: { type: "use_composio_managed_auth", name: `axis-${toolkitSlug}` },
    }),
  });
  const createdId = created.auth_config.id;
  await assertAuthConfigToolkit(createdId, toolkitSlug);
  return createdId;
}

/** Bind an auth-config id to the requested toolkit before it enters authority. */
export async function assertAuthConfigToolkit(authConfigId: string, toolkitSlug: string): Promise<void> {
  const configs = await composioFetch<{ items: ComposioAuthConfig[] }>(
    `/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=100`,
  );
  const config = configs.items.find((item) => item.id === authConfigId);
  if (!config || config.toolkit?.slug !== toolkitSlug) {
    throw new ComposioError("Composio auth config did not match toolkit", 403);
  }
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
  toolkit?: { slug?: string };
  /** Composio returns this on connected-account reads; never expose it to a client. */
  user_id?: string;
  /** Tolerated for API-version compatibility, still verified exactly when present. */
  userId?: string;
  auth_config?: { id?: string };
  experimental?: { account_type?: "PRIVATE" | "PUBLIC" };
  is_disabled?: boolean;
};

export async function getConnectedAccount(connectedAccountId: string): Promise<ConnectedAccount> {
  return composioFetch<ConnectedAccount>(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`);
}

/**
 * v3.1 exact private-account read. The six server-side filters prevent a
 * response for another user/toolkit/config from becoming an authority input;
 * the result is still revalidated by the identity resolver before use.
 */
export async function getPrivateConnectedAccountExact(input: {
  toolkit: SupportedToolkit;
  userId: string;
  authConfigId: string;
  connectedAccountId: string;
  status?: string | null;
}): Promise<ConnectedAccount> {
  const params = new URLSearchParams({
    toolkit_slugs: input.toolkit,
    user_ids: input.userId,
    auth_config_ids: input.authConfigId,
    connected_account_ids: input.connectedAccountId,
    account_type: "PRIVATE",
    limit: "2",
  });
  if (input.status !== null) params.set("statuses", input.status ?? "ACTIVE");
  const response = await composioV31Fetch<{ items?: unknown; total?: unknown; next_cursor?: unknown }>(`/connected_accounts?${params.toString()}`);
  if (response.next_cursor != null || (typeof response.total === "number" && response.total !== 1)) {
    throw new ComposioError("Composio private account did not resolve uniquely", 403);
  }
  if (!Array.isArray(response.items) || response.items.length !== 1) {
    throw new ComposioError("Composio private account was not uniquely resolved", 403);
  }
  return response.items[0] as ConnectedAccount;
}

export async function deleteConnectedAccount(connectedAccountId: string): Promise<void> {
  await composioFetch<void>(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`, { method: "DELETE" });
}

export type ToolExecuteResult = {
  successful: boolean;
  data: unknown;
  error?: string | null;
};

/** Raw provider execution primitive; only composio-identity may import this. */
export async function executeRawComposioTool(opts: {
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
