import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { adapterForAccount, mailErrorStatus, toMailContext } from "@/lib/mail/adapters";
import type { MailProvider } from "@/lib/mail/tokens";

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

  const accounts = await listMailAccounts(user.id);
  const account = accounts.find((a) => a.provider === provider && a.mailEmail === email);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  const adapter = adapterForAccount(account);
  const ctx = toMailContext(user.id, account);
  let capturedUnexpected = false;
  const result = await (async () => {
    try {
      return action === "mark-read" ? await adapter.markRead(ctx, id)
        : action === "mark-unread" ? await adapter.markUnread(ctx, id)
          : action === "archive" ? await adapter.archiveMessage(ctx, id)
            : await adapter.deleteMessage(ctx, id);
    } catch (error) {
      capturedUnexpected = true;
      Sentry.captureException(error, {
        tags: {
          area: "mail",
          op: "mutate",
          action,
          provider,
          transport: account.via ?? "direct",
          code: "unknown",
          status: "502",
        },
        extra: { messageId: id },
      });
      return {
        ok: false,
        error: {
          code: "unknown" as const,
          message: "Mail action failed. Try again.",
          retryable: true,
          provider,
          transport: account.via ?? "direct",
          status: 502,
        },
      };
    }
  })();

  if (result.ok) return NextResponse.json({ ok: true });

  const status = mailErrorStatus(result.error.code);
  if (status >= 500 && !capturedUnexpected) {
    Sentry.captureException(new Error(result.error.message), {
      tags: {
        area: "mail",
        op: "mutate",
        action,
        provider,
        transport: account.via ?? "direct",
        code: result.error.code,
        status: String(status),
      },
      extra: { messageId: id },
    });
  }

  return NextResponse.json(
    {
      error: result.error.message,
      code: result.error.code,
      retryable: result.error.retryable,
    },
    { status },
  );
}
