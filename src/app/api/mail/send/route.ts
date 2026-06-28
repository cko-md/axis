import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts, type MailProvider } from "@/lib/mail/tokens";
import { adapterForAccount, toMailContext, mailErrorStatus } from "@/lib/mail/adapters";

interface SendPayload {
  to: string;
  subject: string;
  body: string;
  provider: MailProvider;
  mailEmail: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

// POST /api/mail/send
// Provider/transport selection + RFC2822/threading is delegated to the mail
// adapter. Reply (inReplyTo present) vs new message is chosen here generically.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: SendPayload;
  try {
    payload = (await req.json()) as SendPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 422 });
  }

  const { to, subject, body, provider, mailEmail, inReplyTo, references, threadId } = payload;
  if (!to?.trim() || !subject?.trim() || !body?.trim() || !provider || !mailEmail) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 422 });
  }

  // Ownership: the account must belong to this user.
  const accounts = await listMailAccounts(user.id);
  const account = accounts.find((a) => a.provider === provider && a.mailEmail === mailEmail);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  const adapter = adapterForAccount(account);
  const ctx = toMailContext(user.id, account);

  const result = inReplyTo
    ? await adapter.replyToMessage(ctx, { to, subject, body, inReplyTo, references, threadId })
    : await adapter.sendMessage(ctx, { to, subject, body });

  if (result.ok) return NextResponse.json({ ok: true });

  const status = mailErrorStatus(result.error.code);
  if (status >= 500) {
    Sentry.captureException(new Error(result.error.message), {
      tags: { area: "mail", op: inReplyTo ? "reply" : "send", provider, transport: account.via ?? "direct", code: result.error.code },
    });
  }
  return NextResponse.json({ error: result.error.message, code: result.error.code }, { status });
}
