import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts, publicMailError, type MailProvider } from "@/lib/mail/tokens";
import { adapterForAccount, toMailContext, mailErrorStatus } from "@/lib/mail/adapters";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";

interface SendPayload {
  to: string;
  subject: string;
  body: string;
  provider: MailProvider;
  mailEmail: string;
  via?: "direct" | "composio";
  connectionId?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

// POST /api/mail/send
// Provider/transport selection + RFC2822/threading is delegated to the mail
// adapter. Reply (inReplyTo present) vs new message is chosen here generically.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: SendPayload;
  try {
    payload = (await req.json()) as SendPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 422 });
  }

  const { to, subject, body, provider, mailEmail, via, connectionId, inReplyTo, references, threadId } = payload;
  if (!to?.trim() || !subject?.trim() || !body?.trim() || !provider || !mailEmail || !connectionId) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 422 });
  }
  if (via && via !== "direct" && via !== "composio") {
    return NextResponse.json({ error: "Invalid mail transport" }, { status: 422 });
  }

  // Ownership: the account must belong to this user.
  let accounts;
  try {
    accounts = await listMailAccounts(user.id);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", route: "/api/mail/send", op: "list_accounts" },
    });
    return NextResponse.json(
      { error: "Mail accounts could not be loaded. Message was not sent.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
  const account = accounts.find((a) => {
    const transport = a.via === "composio" ? "composio" : "direct";
    return a.provider === provider
      && a.mailEmail === mailEmail
      && transport === via
      && a.connectionId === connectionId;
  });
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  const adapter = adapterForAccount(account);
  const ctx = toMailContext(user.id, account);
  const transport = account.via === "composio" ? "composio" : "direct";
  const operation = inReplyTo ? "reply" : "send";
  const timing = {
    area: "mail",
    provider,
    transport,
    operation,
    timeoutMs: 12_000,
    slowMs: 3_000,
  };
  const providerStartedAt = Date.now();

  let result: Awaited<ReturnType<typeof adapter.sendMessage>>;
  try {
    result = await timedProviderOperation(timing, () =>
      inReplyTo
        ? adapter.replyToMessage(ctx, { to, subject, body, inReplyTo, references, threadId })
        : adapter.sendMessage(ctx, { to, subject, body }),
    );
  } catch (error) {
    const isTimeout = error instanceof ProviderTimeoutError;
    logRouteTiming("/api/mail/send", routeStartedAt, {
      provider,
      transport,
      ok: false,
      code: isTimeout ? "timeout" : "network",
    });
    return NextResponse.json(
      {
        error: isTimeout
          ? "Mail provider took too long to send. Check Sent before retrying."
          : "Mail provider could not be reached. Message was not sent.",
        code: isTimeout ? "timeout" : "network",
      },
      { status: isTimeout ? 504 : 502 },
    );
  }

  if (result.ok) {
    logRouteTiming("/api/mail/send", routeStartedAt, { provider, transport, ok: true });
    return NextResponse.json({ ok: true, warning: result.data.warning });
  }

  const safeError = publicMailError(result.error);
  const status = mailErrorStatus(result.error.code);
  recordProviderFailure(
    timing,
    {
      code: safeError.code,
      message: safeError.message,
      status: result.error.status ?? status,
    },
    Date.now() - providerStartedAt,
  );
  logRouteTiming("/api/mail/send", routeStartedAt, {
    provider,
    transport,
    ok: false,
    code: result.error.code,
  });
  if (status >= 500) {
    Sentry.captureException(new Error(safeError.message), {
      tags: {
        area: "mail",
        route: "/api/mail/send",
        op: inReplyTo ? "reply" : "send",
        provider,
        transport,
        code: result.error.code,
        status: String(status),
      },
    });
  }
  return NextResponse.json(
    { error: safeError.message, code: safeError.code, retryable: safeError.retryable },
    { status },
  );
}
