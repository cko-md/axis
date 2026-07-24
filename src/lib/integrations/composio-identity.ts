import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  executeRawComposioTool,
  getPrivateConnectedAccountExact,
  isSupportedToolkit,
  type ConnectedAccount,
  type SupportedToolkit,
} from "@/lib/integrations/composio";
import { isVerifiedComposioReadTool } from "@/lib/integrations/composio-tool-policy";

const MAX_CONNECTIONS_PER_USER = 32;
const AUTHORITY_MAX_AGE_MS = 5 * 60_000;
const REMOTE_PROOF_CONCURRENCY = 3;
const REMOTE_PROOF_DEADLINE_MS = 15_000;

async function mapBoundedBeforeDeadline<T, R>(
  values: readonly T[],
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  const deadlineAt = Date.now() + REMOTE_PROOF_DEADLINE_MS;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(REMOTE_PROOF_CONCURRENCY, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      if (Date.now() >= deadlineAt) continue;
      output[index] = await work(values[index]);
    }
  }));
  return output;
}

function authorityIsFresh(verifiedAt: string | null): boolean {
  if (!verifiedAt) return false;
  const stamp = Date.parse(verifiedAt);
  return Number.isFinite(stamp) && stamp <= Date.now() + 60_000 && Date.now() - stamp <= AUTHORITY_MAX_AGE_MS;
}

/**
 * The only place a raw Composio connected-account id is resolved for normal
 * application traffic. Callers must have already authenticated the Axis user.
 * This module is server-only by convention: never import it from a client
 * component or serialize one of its `VerifiedComposioConnection` values.
 */
export type VerifiedComposioConnection = {
  id: string;
  toolkit: SupportedToolkit;
  accountLabel: string | null;
  connectedAccountId: string;
  remoteVerifiedAt: string;
};

export type ComposioConnectionProjection = {
  id: string;
  toolkit: string;
  status: string;
  accountLabel: string | null;
  createdAt: string;
  updatedAt: string;
  remoteVerifiedAt: string | null;
};

type ConnectionRow = {
  id: string;
  user_id: string;
  toolkit: string;
  connected_account_id: string;
  auth_config_id?: string;
  status: string;
  account_label: string | null;
  created_at: string;
  updated_at: string;
  remote_verified_at: string | null;
  lifecycle_version: number;
  verification_error_code: string | null;
};

type AuthorityRow = {
  connection_id: string;
  user_id: string;
  toolkit: string;
  connected_account_id: string;
  auth_config_id: string;
  lifecycle_state: string;
  remote_verified_at: string | null;
  last_observation: string;
  lifecycle_version: number;
};

export class ComposioIdentityError extends Error {
  constructor(
    public readonly code:
      | "identity_unavailable"
      | "connection_not_found"
      | "connection_not_active"
      | "remote_identity_mismatch"
      | "remote_identity_unverifiable"
      | "remote_auth_config_mismatch"
      | "remote_not_private"
      | "remote_status_unverified",
    public readonly status: number,
  ) {
    super(code);
  }
}

function adminOrThrow(): SupabaseClient<Database> {
  const admin = createAdminClient();
  if (!admin) throw new ComposioIdentityError("identity_unavailable", 503);
  return admin as SupabaseClient<Database>;
}

function remoteToolkit(remote: ConnectedAccount): string | null {
  return typeof remote.toolkit?.slug === "string" && remote.toolkit.slug.trim()
    ? remote.toolkit.slug
    : null;
}

function remoteUserId(remote: ConnectedAccount): string | null {
  if (typeof remote.user_id === "string" && remote.user_id) return remote.user_id;
  return null;
}

function remoteAuthConfigId(remote: ConnectedAccount): string | null {
  if (typeof remote.auth_config?.id === "string" && remote.auth_config.id) return remote.auth_config.id;
  return null;
}

function remoteIsPrivate(remote: ConnectedAccount): boolean {
  return remote.is_disabled === false
    && remote.experimental?.account_type === "PRIVATE";
}

/** Exact account, toolkit, and owner proof from Composio's private API. */
export function assertRemoteBinding(
  row: Pick<AuthorityRow, "user_id" | "toolkit" | "connected_account_id" | "auth_config_id">,
  remote: ConnectedAccount,
  options: { requireActive: boolean },
): void {
  if (remote.id !== row.connected_account_id || remoteToolkit(remote) !== row.toolkit) {
    throw new ComposioIdentityError("remote_identity_mismatch", 403);
  }
  // A remote account without a subject cannot establish the required owner
  // binding. Do not fall back to our locally stored user_id.
  if (remoteUserId(remote) !== row.user_id) {
    throw new ComposioIdentityError("remote_identity_unverifiable", 403);
  }
  if (remoteAuthConfigId(remote) !== row.auth_config_id) {
    throw new ComposioIdentityError("remote_auth_config_mismatch", 403);
  }
  if (!remoteIsPrivate(remote)) {
    throw new ComposioIdentityError("remote_not_private", 403);
  }
  if (options.requireActive && remote.status !== "ACTIVE") {
    throw new ComposioIdentityError("remote_status_unverified", 403);
  }
}

async function authorityForConnection(input: {
  userId: string;
  connectionId: string;
  toolkit?: string;
}): Promise<AuthorityRow | null> {
  let query = adminOrThrow()
    .from("composio_connection_authorities")
    .select("connection_id,user_id,toolkit,connected_account_id,auth_config_id,lifecycle_state,remote_verified_at,last_observation,lifecycle_version")
    .eq("connection_id", input.connectionId)
    .eq("user_id", input.userId);
  if (input.toolkit) query = query.eq("toolkit", input.toolkit);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as AuthorityRow | null;
}

function projection(row: ConnectionRow): ComposioConnectionProjection {
  return {
    id: row.id,
    toolkit: row.toolkit,
    status: row.status,
    accountLabel: row.account_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    remoteVerifiedAt: row.remote_verified_at,
  };
}

export function projectComposioConnection(row: ConnectionRow): ComposioConnectionProjection {
  return projection(row);
}

export async function listComposioConnectionProjections(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ComposioConnectionProjection[]> {
  const limit = Math.min(MAX_CONNECTIONS_PER_USER, Math.max(1, options.limit ?? MAX_CONNECTIONS_PER_USER));
  const offset = Math.max(0, options.offset ?? 0);
  const { data, error } = await adminOrThrow()
    .from("composio_connections")
    .select("id,user_id,toolkit,connected_account_id,auth_config_id,status,account_label,created_at,updated_at,remote_verified_at,lifecycle_version,verification_error_code")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return Promise.all(((data ?? []) as ConnectionRow[]).map(async (row) => {
    const authority = await authorityForConnection({ userId, connectionId: row.id, toolkit: row.toolkit });
    // The public lifecycle column is not authority during the expand window.
    // A forged/legacy ACTIVE row without private membership visibly requires
    // reconnect and never exposes a usable provider account.
    if (!authority || authority.lifecycle_state !== "ACTIVE" || !authorityIsFresh(authority.remote_verified_at) || authority.last_observation !== "ACTIVE") {
      return { ...projection(row), status: "UNVERIFIED", remoteVerifiedAt: null };
    }
    return { ...projection(row), status: "ACTIVE", remoteVerifiedAt: authority.remote_verified_at };
  }));
}

/**
 * Resolve one opaque Axis connection id. The local ACTIVE bit is deliberately
 * insufficient: every action/read is authorized by a fresh private Composio
 * response that proves account id + toolkit + user id + ACTIVE together.
 */
export async function resolveVerifiedComposioConnection(input: {
  userId: string;
  toolkit: SupportedToolkit;
  connectionId: string;
}): Promise<VerifiedComposioConnection> {
  const { data, error } = await adminOrThrow()
    .from("composio_connections")
    .select("id,user_id,toolkit,connected_account_id,auth_config_id,status,account_label,created_at,updated_at,remote_verified_at,lifecycle_version,verification_error_code")
    .eq("id", input.connectionId)
    .eq("user_id", input.userId)
    .eq("toolkit", input.toolkit)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ComposioIdentityError("connection_not_found", 404);

  const row = data as ConnectionRow;
  const authority = await authorityForConnection(input);
  if (!authority || authority.lifecycle_state !== "ACTIVE" || authority.last_observation !== "ACTIVE") {
    throw new ComposioIdentityError("connection_not_active", 403);
  }
  try {
    const remote = await getPrivateConnectedAccountExact({
      toolkit: input.toolkit,
      userId: input.userId,
      authConfigId: authority.auth_config_id,
      connectedAccountId: authority.connected_account_id,
    });
    assertRemoteBinding(authority, remote, { requireActive: true });
  } catch (error) {
    // An observed failed exact proof must not leave a cache-authorizing ACTIVE
    // bit behind. CAS preserves a concurrent reconnect/disconnect winner.
    try {
      await adminOrThrow().rpc("axis_transition_composio_connection_authority", {
        p_connection_id: row.id,
        p_user_id: input.userId,
        p_expected_state: authority.lifecycle_state,
        p_expected_version: authority.lifecycle_version,
        p_next_state: "FAILED",
        p_remote_verified_at: null as never,
        p_public_status: "UNVERIFIED",
        p_verification_error_code: error instanceof ComposioIdentityError ? error.code : "remote_proof_failed",
      });
    } catch { /* identity resolution remains fail-closed if persistence is unavailable */ }
    throw error;
  }
  // A stale local proof triggers a new exact proof, then renews authority via
  // CAS before dispatch. A concurrent revoke/promotion wins fail-closed.
  if (!authorityIsFresh(authority.remote_verified_at)) {
    const verifiedAt = new Date().toISOString();
    const { data: renewed, error: renewError } = await adminOrThrow().rpc(
      "axis_transition_composio_connection_authority",
      {
        p_connection_id: row.id,
        p_user_id: input.userId,
        p_expected_state: "ACTIVE",
        p_expected_version: authority.lifecycle_version,
        p_next_state: "ACTIVE",
        p_remote_verified_at: verifiedAt,
        p_public_status: "ACTIVE",
        p_verification_error_code: null,
      },
    );
    if (renewError || !renewed) throw new ComposioIdentityError("connection_not_active", 403);
  }
  return {
    id: row.id,
    toolkit: input.toolkit,
    accountLabel: row.account_label,
    connectedAccountId: authority.connected_account_id,
    remoteVerifiedAt: new Date().toISOString(),
  };
}

/**
 * The sole high-level dispatch boundary for Composio provider work. Callers
 * hold an opaque local UUID, never a provider account id; resolution performs
 * the fresh exact PRIVATE/ACTIVE proof immediately before dispatch.
 */
export async function executeVerifiedComposioTool(input: {
  userId: string;
  toolkit: SupportedToolkit;
  connectionId: string;
  toolSlug: string;
  arguments?: Record<string, unknown>;
}) {
  if (!isVerifiedComposioReadTool(input.toolkit, input.toolSlug)) {
    throw new ComposioIdentityError("connection_not_active", 403);
  }
  const connection = await resolveVerifiedComposioConnection({
    userId: input.userId,
    toolkit: input.toolkit,
    connectionId: input.connectionId,
  });
  const result = await executeRawComposioTool({
    toolSlug: input.toolSlug,
    connectedAccountId: connection.connectedAccountId,
    userId: input.userId,
    arguments: input.arguments,
  });
  return {
    ...result,
    // Never propagate provider-supplied error strings into a route, log, or
    // Sentry event. Consumers receive a normalized failure signal only.
    error: result.successful ? null : "Provider action was not completed.",
  };
}

/**
 * List only connections that can presently prove private remote authority.
 * A malformed, stale, timed-out, or legacy row is omitted rather than being
 * treated as a usable account.
 */
export async function listVerifiedComposioConnections(
  userId: string,
  toolkits: readonly SupportedToolkit[],
): Promise<VerifiedComposioConnection[]> {
  if (toolkits.length === 0) return [];
  const { data, error } = await adminOrThrow()
    .from("composio_connections")
    .select("id,user_id,toolkit,connected_account_id,auth_config_id,status,account_label,created_at,updated_at,remote_verified_at,lifecycle_version,verification_error_code")
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .in("toolkit", [...toolkits])
    .order("created_at", { ascending: false })
    .limit(MAX_CONNECTIONS_PER_USER)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as ConnectionRow[];
  const verified = await mapBoundedBeforeDeadline(rows, async (row) => {
    if (!isSupportedToolkit(row.toolkit)) return null;
    let authority: AuthorityRow | null = null;
    try {
      authority = await authorityForConnection({ userId, connectionId: row.id, toolkit: row.toolkit });
      if (!authority || authority.lifecycle_state !== "ACTIVE" || !authorityIsFresh(authority.remote_verified_at) || authority.last_observation !== "ACTIVE") return null;
      const remote = await getPrivateConnectedAccountExact({
        toolkit: row.toolkit,
        userId,
        authConfigId: authority.auth_config_id,
        connectedAccountId: authority.connected_account_id,
      });
      assertRemoteBinding(authority, remote, { requireActive: true });
      return {
        id: row.id,
        toolkit: row.toolkit,
        accountLabel: row.account_label,
        connectedAccountId: authority.connected_account_id,
        remoteVerifiedAt: new Date().toISOString(),
      } satisfies VerifiedComposioConnection;
    } catch (error) {
      // The call site must treat absence as unavailable, never as an implicit
      // ACTIVE grant. An observed failed proof also removes the short-lived
      // local cache authority with CAS, unless another lifecycle actor won.
      if (authority) {
        try {
          await adminOrThrow().rpc("axis_transition_composio_connection_authority", {
            p_connection_id: row.id,
            p_user_id: userId,
            p_expected_state: authority.lifecycle_state,
            p_expected_version: authority.lifecycle_version,
            p_next_state: "FAILED",
            p_remote_verified_at: null as never,
            p_public_status: "UNVERIFIED",
            p_verification_error_code: error instanceof ComposioIdentityError ? error.code : "remote_proof_failed",
          });
        } catch { /* fail closed even when the persistence attempt fails */ }
      }
      return null;
    }
  });
  return verified.filter((value): value is VerifiedComposioConnection => value != null);
}

/**
 * Local private membership listing for cache-only UI reads. This deliberately
 * does not contact Composio; it is never sufficient for provider dispatch.
 */
export async function listAuthorizedComposioConnections(
  userId: string,
  toolkits: readonly SupportedToolkit[],
): Promise<VerifiedComposioConnection[]> {
  if (toolkits.length === 0) return [];
  const { data, error } = await adminOrThrow()
    .from("composio_connections")
    .select("id,user_id,toolkit,connected_account_id,auth_config_id,status,account_label,created_at,updated_at,remote_verified_at,lifecycle_version,verification_error_code")
    .eq("user_id", userId)
    .in("toolkit", [...toolkits])
    .order("created_at", { ascending: false })
    .limit(MAX_CONNECTIONS_PER_USER);
  if (error) throw error;
  const result: VerifiedComposioConnection[] = [];
  for (const row of (data ?? []) as ConnectionRow[]) {
    if (!isSupportedToolkit(row.toolkit)) continue;
    const authority = await authorityForConnection({ userId, connectionId: row.id, toolkit: row.toolkit });
    if (!authority || authority.lifecycle_state !== "ACTIVE" || !authorityIsFresh(authority.remote_verified_at) || authority.last_observation !== "ACTIVE") continue;
    result.push({
      id: row.id,
      toolkit: row.toolkit,
      accountLabel: row.account_label,
      connectedAccountId: authority.connected_account_id,
      remoteVerifiedAt: authority.remote_verified_at!,
    });
  }
  return result;
}

/**
 * Refresh a row with compare-and-set lifecycle_version semantics. A late poll
 * cannot overwrite a reconnect/disconnect that advanced the lifecycle.
 */
export async function refreshComposioConnectionAuthority(input: {
  userId: string;
  connectionId: string;
}): Promise<ComposioConnectionProjection | null> {
  const admin = adminOrThrow();
  const { data, error } = await admin
    .from("composio_connections")
    .select("id,user_id,toolkit,connected_account_id,auth_config_id,status,account_label,created_at,updated_at,remote_verified_at,lifecycle_version,verification_error_code")
    .eq("id", input.connectionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as ConnectionRow;
  const authority = await authorityForConnection({ userId: input.userId, connectionId: row.id, toolkit: row.toolkit });
  if (!authority) {
    // Expand-window adoption is deliberately proof-first. A legacy public row
    // is not authority by itself, but it may be preserved when Composio's exact
    // PRIVATE record confirms every stored binding under the same Axis user.
    try {
      if (!isSupportedToolkit(row.toolkit) || !row.auth_config_id) return { ...projection(row), status: "RECONNECT_REQUIRED", remoteVerifiedAt: null };
      const remote = await getPrivateConnectedAccountExact({
        toolkit: row.toolkit,
        userId: input.userId,
        authConfigId: row.auth_config_id,
        connectedAccountId: row.connected_account_id,
      });
      const candidate: AuthorityRow = {
        connection_id: row.id,
        user_id: row.user_id,
        toolkit: row.toolkit,
        connected_account_id: row.connected_account_id,
        auth_config_id: row.auth_config_id!,
        lifecycle_state: "ACTIVE",
        remote_verified_at: null,
        last_observation: "UNKNOWN",
        lifecycle_version: 0,
      };
      assertRemoteBinding(candidate, remote, { requireActive: true });
      const verifiedAt = new Date().toISOString();
      const { data: adopted, error: adoptionError } = await admin.rpc(
        "axis_adopt_composio_connection_authority",
        {
          p_connection_id: row.id,
          p_user_id: input.userId,
          p_toolkit: row.toolkit,
          p_connected_account_id: row.connected_account_id,
          p_auth_config_id: row.auth_config_id,
          p_remote_verified_at: verifiedAt,
          p_public_status: "ACTIVE",
        },
      );
      if (adoptionError) throw adoptionError;
      return adopted
        ? { ...projection(row), status: "ACTIVE", remoteVerifiedAt: verifiedAt }
        : { ...projection(row), status: "RECONNECT_REQUIRED", remoteVerifiedAt: null };
    } catch {
      return { ...projection(row), status: "UNKNOWN", remoteVerifiedAt: null };
    }
  }
  if (authority.lifecycle_state === "DISCONNECTING" || authority.lifecycle_state === "REVOKED") {
    return { ...projection(row), status: "RECONNECT_REQUIRED", remoteVerifiedAt: null };
  }

  try {
    const remote = await getPrivateConnectedAccountExact({
      toolkit: row.toolkit as SupportedToolkit,
      userId: input.userId,
      authConfigId: authority.auth_config_id,
      connectedAccountId: authority.connected_account_id,
    });
    assertRemoteBinding(authority, remote, { requireActive: true });
    const now = new Date().toISOString();
    const promotion = authority.lifecycle_state === "INITIATED";
    const { data: transitioned, error: transitionError } = await admin.rpc(
      promotion ? "axis_promote_composio_connection_authority" : "axis_transition_composio_connection_authority",
      promotion
        ? {
            p_connection_id: row.id,
            p_user_id: input.userId,
            p_toolkit: authority.toolkit,
            p_expected_version: authority.lifecycle_version,
            p_remote_verified_at: now,
          }
        : {
            p_connection_id: row.id,
            p_user_id: input.userId,
            p_expected_state: authority.lifecycle_state,
            p_expected_version: authority.lifecycle_version,
            p_next_state: "ACTIVE",
            p_remote_verified_at: now,
            p_public_status: "ACTIVE",
            p_verification_error_code: null,
          },
    );
    if (transitionError) throw transitionError;
    // A compare-and-set miss means another lifecycle actor won. Never return
    // the stale pre-read ACTIVE projection to a caller.
    return transitioned
      ? { ...projection(row), status: "ACTIVE", remoteVerifiedAt: now }
      : { ...projection(row), status: "UNVERIFIED", remoteVerifiedAt: null };
  } catch (error) {
    // A provider error/malformed response can never refresh authority. Keep
    // the lifecycle tombstone/pending state intact and return a non-authorizing
    // projection; no public-row write can resurrect a disconnect.
    const now = new Date().toISOString();
    if (authority) {
      try {
        await admin.rpc("axis_transition_composio_connection_authority", {
          p_connection_id: row.id,
          p_user_id: input.userId,
          p_expected_state: authority.lifecycle_state,
          p_expected_version: authority.lifecycle_version,
          p_next_state: "FAILED",
          // Generated database types predate nullable timestamp support.
          p_remote_verified_at: null as never,
          p_public_status: "UNVERIFIED",
          p_verification_error_code: error instanceof ComposioIdentityError ? error.code : "remote_observation_unknown",
        });
      } catch { /* a CAS loser remains non-authorizing */ }
    }
    return { ...projection(row), status: error instanceof ComposioIdentityError ? "RECONNECT_REQUIRED" : "UNKNOWN", remoteVerifiedAt: null, updatedAt: now };
  }
}
