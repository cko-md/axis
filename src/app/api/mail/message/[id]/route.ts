import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { adapterForAccount, toMailContext, mailErrorStatus } from "@/lib/mail/adapters";

// GET /api/mail/message/[id]?provider=gmail|outlook&email=user@example.com
// Provider/transport selection is delegated to the mail adapter — this route
// works identically for direct-OAuth and Composio accounts.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = req.nextUrl.searchParams.get("provider");
  const email = req.nextUrl.searchParams.get("email");

  if (provider !== "gmail" && provider !== "outlook") {
    return NextResponse.json({ error: "provider must be gmail or outlook" }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ error: "email param is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Ownership: the account must belong to this user (and tells us the transport).
  const accounts = await listMailAccounts(user.id);
  const account = accounts.find((a) => a.provider === provider && a.mailEmail === email);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  const adapter = adapterForAccount(account);
  const result = await adapter.getMessage(toMailContext(user.id, account), id);

  if (result.ok) return NextResponse.json(result.data);

  const status = mailErrorStatus(result.error.code);
  if (status >= 500) {
    Sentry.captureException(new Error(result.error.message), {
      tags: { area: "mail", op: "get_message", provider, transport: account.via ?? "direct", code: result.error.code },
    });
  }
  return NextResponse.json({ error: result.error.message, code: result.error.code }, { status });
}
