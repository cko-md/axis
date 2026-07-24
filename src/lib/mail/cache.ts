import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MailMessage } from "./gmail";
import type { MailAccountRef } from "./tokens";

type AxisSupabase = SupabaseClient<Database>;
type CacheRow = Database["public"]["Tables"]["mail_message_cache"]["Row"];
type CacheInsert = Database["public"]["Tables"]["mail_message_cache"]["Insert"];
type SyncInsert = Database["public"]["Tables"]["integration_sync_state"]["Insert"];

export type MailSyncState = {
  provider: "gmail" | "outlook";
  transport: "direct" | "composio";
  /** Axis-owned opaque connection selector; never use the display label as identity. */
  connectionId: string;
  accountEmail: string;
  status: "success" | "error";
  lastAttemptedAt: string;
  lastSyncedAt: string | null;
  errorCode: string | null;
};

export function mailAccountTransport(account: MailAccountRef): "direct" | "composio" {
  return account.via === "composio" ? "composio" : "direct";
}

export function mailAccountRef(account: MailAccountRef): string {
  // The current Mail transport is Composio-only. A provider label or mailbox
  // address is user-facing metadata and is not unique enough to scope writes.
  return account.connectionId ?? "";
}

function parsedReceivedAt(value: string): string | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function messageToCacheInsert(
  userId: string,
  account: MailAccountRef,
  message: MailMessage,
  syncGeneration: string,
  fetchedAt: string,
): CacheInsert {
  return {
    user_id: userId,
    provider: account.provider,
    transport: mailAccountTransport(account),
    account_ref: mailAccountRef(account),
    account_email: account.mailEmail,
    composio_connection_id: account.connectionId ?? null,
    provider_message_id: message.id,
    thread_id: message.threadId,
    sender: message.from,
    subject: message.subject,
    snippet: message.snippet,
    message_date: message.date,
    received_at: parsedReceivedAt(message.date),
    is_unread: message.isUnread,
    sync_generation: syncGeneration,
    fetched_at: fetchedAt,
    updated_at: fetchedAt,
  };
}

export function messageFromCacheRow(row: CacheRow): MailMessage {
  return {
    id: row.provider_message_id,
    threadId: row.thread_id,
    from: row.sender,
    subject: row.subject,
    date: row.message_date,
    snippet: row.snippet,
    isUnread: row.is_unread,
    provider: row.provider as "gmail" | "outlook",
    accountEmail: row.account_email,
    connectionId: row.composio_connection_id ?? undefined,
  };
}

export async function readMailCache(
  supabase: AxisSupabase,
  userId: string,
  account?: Pick<MailAccountRef, "connectionId">,
): Promise<{ messages: MailMessage[]; fetchedAt: string | null }> {
  let query = supabase
    .from("mail_message_cache")
    .select("user_id,provider,transport,account_ref,account_email,composio_connection_id,provider_message_id,thread_id,sender,subject,snippet,message_date,received_at,is_unread,sync_generation,fetched_at,updated_at")
    .eq("user_id", userId)
    // Legacy cache rows without an Axis connection binding must not be shown:
    // they cannot be safely disambiguated when two mailboxes share a label.
    .not("composio_connection_id", "is", null);
  if (account) {
    if (!account.connectionId) throw new Error("Mail cache connection selector is missing");
    query = query.eq("composio_connection_id", account.connectionId);
  }
  const { data, error } = await query
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw error;
  const rows = data ?? [];
  return {
    messages: rows.map((row) => messageFromCacheRow(row as CacheRow)),
    fetchedAt: rows.reduce<string | null>(
      (latest, row) => (!latest || row.fetched_at > latest ? row.fetched_at : latest),
      null,
    ),
  };
}

export async function readMailSyncState(
  supabase: AxisSupabase,
  userId: string,
): Promise<MailSyncState[]> {
  const { data, error } = await supabase
    .from("integration_sync_state")
    .select("provider,transport,composio_connection_id,account_label,last_status,last_attempted_at,last_synced_at,last_error_code")
    .eq("user_id", userId)
    .eq("domain", "mail")
    .not("composio_connection_id", "is", null)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    provider: row.provider as "gmail" | "outlook",
    transport: row.transport as "direct" | "composio",
    connectionId: row.composio_connection_id!,
    accountEmail: row.account_label,
    status: row.last_status as "success" | "error",
    lastAttemptedAt: row.last_attempted_at,
    lastSyncedAt: row.last_synced_at,
    errorCode: row.last_error_code,
  }));
}

export async function persistMailSyncSuccess(
  supabase: AxisSupabase,
  userId: string,
  account: MailAccountRef,
  messages: MailMessage[],
  opts: { generation: string; fetchedAt: string; reconcileFirstPage: boolean },
): Promise<void> {
  const accountRef = mailAccountRef(account);
  if (!accountRef) throw new Error("Mail cache account reference is missing");
  const rows = messages.map((message) =>
    messageToCacheInsert(userId, account, message, opts.generation, opts.fetchedAt),
  );
  if (rows.length > 0) {
    const { error } = await supabase.from("mail_message_cache").upsert(rows, {
      onConflict: "user_id,provider,transport,account_ref,provider_message_id",
    });
    if (error) throw error;
  }

  if (opts.reconcileFirstPage) {
    let cleanup = supabase
      .from("mail_message_cache")
      .delete()
      .eq("user_id", userId)
      .eq("provider", account.provider)
      .eq("transport", mailAccountTransport(account))
      .eq("account_ref", accountRef);
    if (rows.length > 0) {
      const received = rows
        .map((row) => row.received_at)
        .filter((value): value is string => typeof value === "string")
        .sort();
      if (received.length > 0) {
        cleanup = cleanup.gte("received_at", received[0]).neq("sync_generation", opts.generation);
        const { error } = await cleanup;
        if (error) throw error;
      }
    } else {
      const { error } = await cleanup;
      if (error) throw error;
    }
  }

  const state: SyncInsert = {
    user_id: userId,
    domain: "mail",
    provider: account.provider,
    transport: mailAccountTransport(account),
    account_ref: accountRef,
    account_label: account.mailEmail,
    composio_connection_id: account.connectionId ?? null,
    last_status: "success",
    last_attempted_at: opts.fetchedAt,
    last_synced_at: opts.fetchedAt,
    last_error_code: null,
    sync_generation: opts.generation,
    updated_at: opts.fetchedAt,
  };
  const { error: stateError } = await supabase.from("integration_sync_state").upsert(state, {
    onConflict: "user_id,domain,provider,transport,account_ref",
  });
  if (stateError) throw stateError;
}

export async function persistMailSyncFailure(
  supabase: AxisSupabase,
  userId: string,
  account: MailAccountRef,
  errorCode: string,
  attemptedAt: string,
): Promise<void> {
  const accountRef = mailAccountRef(account);
  if (!accountRef) return;
  const { data: previous, error: previousError } = await supabase
    .from("integration_sync_state")
    .select("last_synced_at,sync_generation")
    .eq("user_id", userId)
    .eq("domain", "mail")
    .eq("provider", account.provider)
    .eq("transport", mailAccountTransport(account))
    .eq("account_ref", accountRef)
    .maybeSingle();
  if (previousError) throw previousError;
  const state: SyncInsert = {
    user_id: userId,
    domain: "mail",
    provider: account.provider,
    transport: mailAccountTransport(account),
    account_ref: accountRef,
    account_label: account.mailEmail,
    composio_connection_id: account.connectionId ?? null,
    last_status: "error",
    last_attempted_at: attemptedAt,
    last_synced_at: previous?.last_synced_at ?? null,
    last_error_code: errorCode,
    sync_generation: previous?.sync_generation ?? null,
    updated_at: attemptedAt,
  };
  const { error } = await supabase.from("integration_sync_state").upsert(state, {
    onConflict: "user_id,domain,provider,transport,account_ref",
  });
  if (error) throw error;
}

export async function updateCachedMessageAfterAction(
  supabase: AxisSupabase,
  userId: string,
  account: MailAccountRef,
  messageId: string,
  action: "mark-read" | "mark-unread" | "archive" | "delete",
): Promise<void> {
  const query = action === "archive" || action === "delete"
    ? supabase.from("mail_message_cache").delete()
    : supabase.from("mail_message_cache").update({ is_unread: action === "mark-unread", updated_at: new Date().toISOString() });
  const { error } = await query
    .eq("user_id", userId)
    .eq("provider", account.provider)
    .eq("transport", mailAccountTransport(account))
    .eq("account_ref", mailAccountRef(account))
    .eq("provider_message_id", messageId);
  if (error) throw error;
}

export async function deleteMailCacheForAccount(
  supabase: AxisSupabase,
  userId: string,
  account: Pick<MailAccountRef, "provider" | "mailEmail" | "via" | "connectionId">,
): Promise<void> {
  const accountRef = mailAccountRef(account);
  if (!accountRef) return;
  const transport = mailAccountTransport(account);
  const [cache, state] = await Promise.all([
    supabase
      .from("mail_message_cache")
      .delete()
      .eq("user_id", userId)
      .eq("provider", account.provider)
      .eq("transport", transport)
      .eq("account_ref", accountRef),
    supabase
      .from("integration_sync_state")
      .delete()
      .eq("user_id", userId)
      .eq("domain", "mail")
      .eq("provider", account.provider)
      .eq("transport", transport)
      .eq("account_ref", accountRef),
  ]);
  if (cache.error) throw cache.error;
  if (state.error) throw state.error;
}
