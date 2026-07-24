import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listMailAccounts,
  projectMailAccount,
  projectMailMessage,
  publicMailError,
  type MailAccountRef,
} from "@/lib/mail/tokens";
import type { MailMessage } from "@/lib/mail/gmail";
import { adapterForAccount, mailErrorStatus, toMailContext } from "@/lib/mail/adapters";
import { persistMailSyncFailure, persistMailSyncSuccess } from "@/lib/mail/cache";
import { redisRateLimit } from "@/lib/ratelimit";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";

type SyncRequest = {
  connectionId?: unknown;
  account?: unknown;
  provider?: unknown;
  pageToken?: unknown;
  skip?: unknown;
};

const MAX_SYNC_BODY_BYTES = 4_096;
const MAX_PAGE_TOKEN_LENGTH = 2_048;
const SYNC_DEADLINE_MS = 15_000;
const SYNC_CONCURRENCY = 2;

type ParsedSyncRequest = {
  connectionId?: string;
  accountEmail?: string;
  provider?: "gmail" | "outlook";
  pageToken?: string;
  skip: number;
};

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

async function parseSyncRequest(req: NextRequest): Promise<
  { ok: true; data: ParsedSyncRequest } | { ok: false; status: 400 | 413 | 415; error: string }
> {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, error: "application/json is required" };
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SYNC_BODY_BYTES) {
    return { ok: false, status: 413, error: "Request body is too large" };
  }
  const reader = req.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "Invalid JSON" };
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_SYNC_BODY_BYTES) {
        await reader.cancel("mail_sync_body_too_large");
        return { ok: false, status: 413, error: "Request body is too large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  } finally {
    reader.releaseLock();
  }

  let raw: SyncRequest;
  try {
    raw = JSON.parse(text) as SyncRequest;
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
  const connectionId = boundedString(raw.connectionId, 64);
  const accountEmail = boundedString(raw.account, 320);
  const provider = raw.provider === "gmail" || raw.provider === "outlook" ? raw.provider : undefined;
  const pageToken = boundedString(raw.pageToken, MAX_PAGE_TOKEN_LENGTH);
  const invalidString = (raw.connectionId !== undefined && !connectionId)
    || (raw.account !== undefined && !accountEmail)
    || (raw.pageToken !== undefined && !pageToken)
    || (raw.provider !== undefined && !provider);
  const skip = typeof raw.skip === "number" && Number.isSafeInteger(raw.skip) && raw.skip >= 0
    ? raw.skip
    : 0;
  if (invalidString || (Boolean(accountEmail) !== Boolean(provider))) {
    return { ok: false, status: 400, error: "Invalid mailbox selector" };
  }
  if ((pageToken || skip > 0) && !connectionId) {
    return { ok: false, status: 400, error: "Pagination requires a connectionId" };
  }
  return { ok: true, data: { connectionId, accountEmail, provider, pageToken, skip } };
}

function captureSafeSyncFailure(operation: string, tags: Record<string, string> = {}) {
  Sentry.captureException(new Error(`Mail sync ${operation} failed`), {
    tags: { area: "mail", route: "/api/mail/sync", op: operation, ...tags },
  });
}

type MailInboxAccountError = {
  provider: "gmail" | "outlook";
  connectionId: string;
  accountEmail: string;
  transport: "direct" | "composio";
  code: string;
  message: string;
};

function accountError(
  account: MailAccountRef,
  code: string,
  message: string,
): MailInboxAccountError {
  return {
    provider: account.provider,
    connectionId: account.connectionId ?? "",
    accountEmail: account.mailEmail,
    transport: account.via === "composio" ? "composio" : "direct",
    code,
    message,
  };
}

// Explicit inbox revalidation. It returns live normalized rows for immediate UI
// replacement and writes the same metadata to the owner-scoped cache. A failed
// provider refresh records safe sync state and never deletes last-known rows.
export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    captureSafeSyncFailure("authenticate");
    return NextResponse.json({ error: "Authentication is temporarily unavailable." }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Saved inbox authority is unavailable.", code: "identity_unavailable" }, { status: 503 });

  let admission;
  try {
    admission = await redisRateLimit(user.id, 12, "1 m", "axis-mail-sync");
  } catch {
    captureSafeSyncFailure("admission");
    return NextResponse.json({ error: "Mail sync admission is unavailable. Try again shortly." }, { status: 503 });
  }
  if (!admission) {
    return NextResponse.json({ error: "Mail sync admission is unavailable. Try again shortly." }, { status: 503 });
  }
  if (!admission.success) {
    return NextResponse.json({ error: "Mail sync rate limit exceeded. Try again shortly." }, { status: 429 });
  }

  const parsed = await parseSyncRequest(req);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const { connectionId, accountEmail, provider, pageToken, skip } = parsed.data;

  let allAccounts: MailAccountRef[];
  try {
    allAccounts = await listMailAccounts(user.id, { verifyRemote: false });
  } catch {
    captureSafeSyncFailure("list_accounts");
    return NextResponse.json(
      { error: "Mail accounts could not be loaded.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }

  const accounts = connectionId
    ? allAccounts.filter((account) => account.connectionId === connectionId)
    : allAccounts;
  if (connectionId && accounts.length !== 1) {
    return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
  }
  if (accounts.some((account) =>
    (provider !== undefined && account.provider !== provider)
    || (accountEmail !== undefined && account.mailEmail !== accountEmail),
  )) {
    return NextResponse.json({ error: "Mailbox selector does not match the connected mailbox" }, { status: 400 });
  }

  const generation = crypto.randomUUID();
  const attemptedAt = new Date().toISOString();
  const deadlineAt = Date.now() + SYNC_DEADLINE_MS;
  const syncOne = async (account: MailAccountRef) => {
    if (Date.now() >= deadlineAt) {
      await persistMailSyncFailure(admin, user.id, account, "sync_deadline_exhausted", attemptedAt)
        .catch(() => captureSafeSyncFailure("persist_deadline_state", { provider: account.provider }));
      return {
        account,
        messages: [] as MailMessage[],
        error: accountError(account, "sync_deadline_exhausted", "This mailbox was not started before the sync window elapsed."),
      };
    }
    const adapter = adapterForAccount(account);
    const transport = account.via === "composio" ? "composio" : "direct";
    const timeoutMs = Math.min(8_000, Math.max(1, deadlineAt - Date.now()));
    const timing = {
      area: "mail",
      provider: account.provider,
      transport,
      operation: "sync_inbox",
      timeoutMs,
      slowMs: 2_000,
    } as const;
    const accountStartedAt = Date.now();

    try {
      const result = await timedProviderOperation(timing, () =>
        adapter.listInbox(toMailContext(user.id, account), { pageToken, skip }),
      );
      if (!result.ok) {
        const safeError = publicMailError(result.error);
        recordProviderFailure(timing, {
          code: safeError.code,
          message: safeError.message,
          status: result.error.status ?? mailErrorStatus(result.error.code),
        }, Date.now() - accountStartedAt);
        await persistMailSyncFailure(admin, user.id, account, result.error.code, attemptedAt)
          .catch(() => captureSafeSyncFailure("persist_failure_state", { provider: account.provider, transport }));
        return { account, messages: [] as MailMessage[], error: accountError(account, safeError.code, safeError.message) };
      }

      try {
        await persistMailSyncSuccess(admin, user.id, account, result.data.messages, {
          generation,
          fetchedAt: attemptedAt,
          reconcileFirstPage: !pageToken && skip === 0,
        });
      } catch {
        captureSafeSyncFailure("persist_cache", { provider: account.provider, transport });
        await persistMailSyncFailure(admin, user.id, account, "cache_write_failed", attemptedAt)
          .catch(() => captureSafeSyncFailure("persist_cache_failure_state", { provider: account.provider, transport }));
        return {
          account,
          messages: result.data.messages,
          error: accountError(account, "cache_write_failed", "Mailbox refreshed, but the saved inbox could not be updated."),
          pagination: result.data,
        };
      }
      return { account, messages: result.data.messages, pagination: result.data };
    } catch (error) {
      const code = error instanceof ProviderTimeoutError ? "timeout" : "network";
      await persistMailSyncFailure(admin, user.id, account, code, attemptedAt)
        .catch(() => captureSafeSyncFailure("persist_failure_state", { provider: account.provider, transport }));
      return {
        account,
        messages: [] as MailMessage[],
        error: accountError(
          account,
          code,
          code === "timeout" ? "This mailbox took too long to respond." : "This mailbox could not be reached.",
        ),
      };
    }
  };
  const perAccount: Awaited<ReturnType<typeof syncOne>>[] = [];
  let nextAccountIndex = 0;
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, accounts.length) }, async () => {
    while (true) {
      const index = nextAccountIndex++;
      if (index >= accounts.length) return;
      perAccount[index] = await syncOne(accounts[index]);
    }
  }));

  const errors = perAccount.flatMap((result) => result.error ? [result.error] : []);
  const all = perAccount.flatMap((result) => result.messages).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  const publicMessages = perAccount
    .flatMap((result) => result.messages.map((message) => projectMailMessage(message, result.account)))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const pagination = perAccount.find((result) => result.pagination)?.pagination;
  logRouteTiming("/api/mail/sync", routeStartedAt, {
    accounts: accounts.length,
    messages: all.length,
    partial: errors.length > 0,
  });
  return NextResponse.json({
    messages: publicMessages,
    accounts: allAccounts.map(projectMailAccount),
    partial: errors.length > 0,
    errors,
    fetchedAt: attemptedAt,
    fromCache: false,
    nextPageToken: pagination?.nextPageToken,
    hasMore: pagination?.hasMore ?? Boolean(pagination?.nextPageToken),
    skip: skip + all.length,
  });
}
