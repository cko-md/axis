import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import type { MailMessage } from "@/lib/mail/gmail";
import { adapterForAccount, mailErrorStatus, toMailContext } from "@/lib/mail/adapters";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";

type MailInboxAccountError = {
  provider: "gmail" | "outlook";
  accountEmail: string;
  transport: "direct" | "composio";
  code: string;
  message: string;
};

// GET /api/mail/inbox
// Optional per-account pagination: ?account=email@x.com&provider=gmail&pageToken=...&skip=0
// Without those params: fetches page 1 for all connected accounts.
//
// Provider/transport selection is fully delegated to the mail adapter layer —
// this route no longer branches on gmail/outlook/composio. A single account's
// failure is captured (Sentry) and skipped, never blanking the whole inbox.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const accountParam = req.nextUrl.searchParams.get("account") ?? undefined;
  const providerParam = req.nextUrl.searchParams.get("provider") ?? undefined;
  const pageToken = req.nextUrl.searchParams.get("pageToken") ?? undefined;
  const skip = parseInt(req.nextUrl.searchParams.get("skip") ?? "0", 10);

  let allAccounts;
  try {
    allAccounts = await listMailAccounts(user.id);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", route: "/api/mail/inbox", op: "list_accounts" },
    });
    logRouteTiming("/api/mail/inbox", routeStartedAt, {
      accounts: 0,
      messages: 0,
      partial: true,
      code: "account_status_unavailable",
    });
    return NextResponse.json(
      { error: "Mail accounts could not be loaded. Try refreshing.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }

  // If a specific account is requested, only fetch that one.
  const accountsToFetch =
    accountParam && providerParam
      ? allAccounts.filter((a) => a.mailEmail === accountParam && a.provider === providerParam)
      : allAccounts;

  const perAccount = await Promise.all(
    accountsToFetch.map(async (acct) => {
      const adapter = adapterForAccount(acct);
      const transport = acct.via === "composio" ? "composio" : "direct";
      const timing = {
        area: "mail",
        provider: acct.provider,
        transport,
        operation: "list_inbox",
        timeoutMs: 8_000,
        slowMs: 2_000,
      };
      const accountStartedAt = Date.now();

      try {
        const result = await timedProviderOperation(timing, () =>
          adapter.listInbox(toMailContext(user.id, acct), { pageToken, skip }),
        );
        if (result.ok) {
          return {
            messages: result.data.messages,
            pagination:
              accountParam && providerParam
                ? {
                    nextPageToken: result.data.nextPageToken,
                    hasMore: result.data.hasMore ?? Boolean(result.data.nextPageToken),
                    skip: skip + result.data.messages.length,
                  }
                : undefined,
          };
        }

        recordProviderFailure(
          timing,
          {
            code: result.error.code,
            message: result.error.message,
            status: result.error.status ?? mailErrorStatus(result.error.code),
          },
          Date.now() - accountStartedAt,
        );
        return {
          messages: [] as MailMessage[],
          error: {
            provider: acct.provider,
            accountEmail: acct.mailEmail,
            transport,
            code: result.error.code,
            message: result.error.message,
          } satisfies MailInboxAccountError,
        };
      } catch (error) {
        const isTimeout = error instanceof ProviderTimeoutError;
        Sentry.addBreadcrumb({
          category: "mail.partial",
          level: "warning",
          message: "Inbox account skipped",
          data: {
            area: "mail",
            provider: acct.provider,
            transport,
            code: isTimeout ? "timeout" : "network",
          },
        });
        return {
          messages: [] as MailMessage[],
          error: {
            provider: acct.provider,
            accountEmail: acct.mailEmail,
            transport,
            code: isTimeout ? "timeout" : "network",
            message: isTimeout
              ? "This mailbox took too long to respond."
              : "This mailbox could not be reached.",
          } satisfies MailInboxAccountError,
        };
      }
    }),
  );

  const errors = perAccount.flatMap((result) => (result.error ? [result.error] : []));
  const pagination = perAccount.find((result) => result.pagination)?.pagination;
  const all = perAccount.flatMap((result) => result.messages).sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    return db - da;
  });

  logRouteTiming("/api/mail/inbox", routeStartedAt, {
    accounts: accountsToFetch.length,
    messages: all.length,
    partial: errors.length > 0,
  });

  return NextResponse.json({
    messages: all,
    accounts: allAccounts,
    partial: errors.length > 0,
    errors,
    fetchedAt: new Date().toISOString(),
    nextPageToken: pagination?.nextPageToken,
    hasMore: pagination?.hasMore ?? false,
    skip: pagination?.skip,
  });
}
