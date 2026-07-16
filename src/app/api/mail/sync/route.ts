import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts, type MailAccountRef } from "@/lib/mail/tokens";
import type { MailMessage } from "@/lib/mail/gmail";
import { adapterForAccount, mailErrorStatus, toMailContext } from "@/lib/mail/adapters";
import { persistMailSyncFailure, persistMailSyncSuccess } from "@/lib/mail/cache";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";

type SyncRequest = {
  account?: unknown;
  provider?: unknown;
  pageToken?: unknown;
  skip?: unknown;
};

type MailInboxAccountError = {
  provider: "gmail" | "outlook";
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const accountEmail = typeof body.account === "string" ? body.account : undefined;
  const provider = body.provider === "gmail" || body.provider === "outlook" ? body.provider : undefined;
  const pageToken = typeof body.pageToken === "string" ? body.pageToken : undefined;
  const skip = typeof body.skip === "number" && Number.isSafeInteger(body.skip) && body.skip >= 0
    ? body.skip
    : 0;
  if ((accountEmail && !provider) || (!accountEmail && provider)) {
    return NextResponse.json({ error: "account and provider must be supplied together" }, { status: 400 });
  }

  let allAccounts: MailAccountRef[];
  try {
    allAccounts = await listMailAccounts(user.id);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", route: "/api/mail/sync", op: "list_accounts" },
    });
    return NextResponse.json(
      { error: "Mail accounts could not be loaded.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }

  const accounts = accountEmail && provider
    ? allAccounts.filter((account) => account.mailEmail === accountEmail && account.provider === provider)
    : allAccounts;
  if (accountEmail && provider && accounts.length === 0) {
    return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
  }

  const generation = crypto.randomUUID();
  const attemptedAt = new Date().toISOString();
  const perAccount = await Promise.all(accounts.map(async (account) => {
    const adapter = adapterForAccount(account);
    const transport = account.via === "composio" ? "composio" : "direct";
    const timing = {
      area: "mail",
      provider: account.provider,
      transport,
      operation: "sync_inbox",
      timeoutMs: 8_000,
      slowMs: 2_000,
    } as const;
    const accountStartedAt = Date.now();

    try {
      const result = await timedProviderOperation(timing, () =>
        adapter.listInbox(toMailContext(user.id, account), { pageToken, skip }),
      );
      if (!result.ok) {
        recordProviderFailure(timing, {
          code: result.error.code,
          message: result.error.message,
          status: result.error.status ?? mailErrorStatus(result.error.code),
        }, Date.now() - accountStartedAt);
        await persistMailSyncFailure(supabase, user.id, account, result.error.code, attemptedAt)
          .catch((cacheError) => Sentry.captureException(cacheError, {
            tags: { area: "mail", route: "/api/mail/sync", op: "persist_failure_state" },
          }));
        return { messages: [] as MailMessage[], error: accountError(account, result.error.code, result.error.message) };
      }

      try {
        await persistMailSyncSuccess(supabase, user.id, account, result.data.messages, {
          generation,
          fetchedAt: attemptedAt,
          reconcileFirstPage: !pageToken && skip === 0,
        });
      } catch (cacheError) {
        Sentry.captureException(cacheError, {
          tags: { area: "mail", route: "/api/mail/sync", op: "persist_cache", provider: account.provider, transport },
        });
        await persistMailSyncFailure(supabase, user.id, account, "cache_write_failed", attemptedAt)
          .catch((stateError) => Sentry.captureException(stateError, {
            tags: { area: "mail", route: "/api/mail/sync", op: "persist_cache_failure_state" },
          }));
        return {
          messages: result.data.messages,
          error: accountError(account, "cache_write_failed", "Mailbox refreshed, but the saved inbox could not be updated."),
          pagination: result.data,
        };
      }
      return { messages: result.data.messages, pagination: result.data };
    } catch (error) {
      const code = error instanceof ProviderTimeoutError ? "timeout" : "network";
      await persistMailSyncFailure(supabase, user.id, account, code, attemptedAt)
        .catch((cacheError) => Sentry.captureException(cacheError, {
          tags: { area: "mail", route: "/api/mail/sync", op: "persist_failure_state" },
        }));
      return {
        messages: [] as MailMessage[],
        error: accountError(
          account,
          code,
          code === "timeout" ? "This mailbox took too long to respond." : "This mailbox could not be reached.",
        ),
      };
    }
  }));

  const errors = perAccount.flatMap((result) => result.error ? [result.error] : []);
  const all = perAccount.flatMap((result) => result.messages).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  const pagination = perAccount.find((result) => result.pagination)?.pagination;
  logRouteTiming("/api/mail/sync", routeStartedAt, {
    accounts: accounts.length,
    messages: all.length,
    partial: errors.length > 0,
  });
  return NextResponse.json({
    messages: all,
    accounts: allAccounts,
    partial: errors.length > 0,
    errors,
    fetchedAt: attemptedAt,
    fromCache: false,
    nextPageToken: pagination?.nextPageToken,
    hasMore: pagination?.hasMore ?? Boolean(pagination?.nextPageToken),
    skip: skip + all.length,
  });
}
