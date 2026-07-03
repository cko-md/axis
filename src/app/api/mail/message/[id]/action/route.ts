import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { adapterForAccount, mailErrorStatus, toMailContext } from "@/lib/mail/adapters";
import type { MailProvider } from "@/lib/mail/tokens";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";

type MailMessageAction = "mark-read" | "mark-unread" | "archive" | "delete";

function isMailAction(action: unknown): action is MailMessageAction {
  return action === "mark-read" || action === "mark-unread" || action === "archive" || action === "delete";
}

function isMailProvider(provider: unknown): provider is MailProvider {
  return provider === "gmail" || provider === "outlook";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const routeStartedAt = Date.now();
  const { id } = await params;
  const body = await req.json().catch(() => null) as {
    action?: unknown;
    provider?: unknown;
    email?: unknown;
  } | null;

  if (!body || !isMailAction(body.action)) {
    return NextResponse.json({ error: "action must be mark-read, mark-unread, archive, or delete" }, { status: 400 });
  }
  if (!isMailProvider(body.provider)) {
    return NextResponse.json({ error: "provider must be gmail or outlook" }, { status: 400 });
  }
  if (typeof body.email !== "string" || !body.email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  const action = body.action;
  const provider = body.provider;
  const email = body.email;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let accounts;
  try {
    accounts = await listMailAccounts(user.id);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", route: "/api/mail/message/[id]/action", op: "list_accounts" },
    });
    return NextResponse.json(
      { error: "Mail accounts could not be loaded. Message was not updated.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
  const account = accounts.find((a) => a.provider === provider && a.mailEmail === email);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  const adapter = adapterForAccount(account);
  const ctx = toMailContext(user.id, account);
  const transport = account.via === "composio" ? "composio" : "direct";
  const timing = {
    area: "mail",
    provider,
    transport,
    operation: action,
    timeoutMs: 8_000,
    slowMs: 2_000,
  };
  const providerStartedAt = Date.now();
  const result = await (async () => {
    try {
      return await timedProviderOperation(timing, () =>
        action === "mark-read" ? adapter.markRead(ctx, id)
          : action === "mark-unread" ? adapter.markUnread(ctx, id)
            : action === "archive" ? adapter.archiveMessage(ctx, id)
              : adapter.deleteMessage(ctx, id),
      );
    } catch (error) {
      const isTimeout = error instanceof ProviderTimeoutError;
      logRouteTiming("/api/mail/message/[id]/action", routeStartedAt, {
        provider,
        transport,
        action,
        ok: false,
        code: "network",
        status: isTimeout ? 504 : 502,
      });
      return {
        ok: false,
        error: {
          code: "network" as const,
          message: isTimeout
            ? "Mail provider took too long to update this message. Try again."
            : "Mail action failed. Try again.",
          retryable: true,
          provider,
          transport,
          status: isTimeout ? 504 : 502,
        },
      };
    }
  })();

  if (result.ok) {
    logRouteTiming("/api/mail/message/[id]/action", routeStartedAt, {
      provider,
      transport,
      action,
      ok: true,
    });
    return NextResponse.json({ ok: true });
  }

  const status = result.error.status ?? mailErrorStatus(result.error.code);
  recordProviderFailure(
    timing,
    {
      code: result.error.code,
      message: result.error.message,
      status: result.error.status ?? status,
    },
    Date.now() - providerStartedAt,
  );
  logRouteTiming("/api/mail/message/[id]/action", routeStartedAt, {
    provider,
    transport,
    action,
    ok: false,
    code: result.error.code,
  });

  return NextResponse.json(
    {
      error: result.error.message,
      code: result.error.code,
      retryable: result.error.retryable,
    },
    { status },
  );
}
