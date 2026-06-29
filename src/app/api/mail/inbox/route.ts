import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import type { MailMessage } from "@/lib/mail/gmail";
import { adapterForAccount, toMailContext } from "@/lib/mail/adapters";

// GET /api/mail/inbox
// Optional per-account pagination: ?account=email@x.com&provider=gmail&pageToken=...&skip=0
// Without those params: fetches page 1 for all connected accounts.
//
// Provider/transport selection is fully delegated to the mail adapter layer —
// this route no longer branches on gmail/outlook/composio. A single account's
// failure is captured (Sentry) and skipped, never blanking the whole inbox.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const accountParam = req.nextUrl.searchParams.get("account") ?? undefined;
  const providerParam = req.nextUrl.searchParams.get("provider") ?? undefined;
  const pageToken = req.nextUrl.searchParams.get("pageToken") ?? undefined;
  const skip = parseInt(req.nextUrl.searchParams.get("skip") ?? "0", 10);

  const allAccounts = await listMailAccounts(user.id);

  // If a specific account is requested, only fetch that one.
  const accountsToFetch =
    accountParam && providerParam
      ? allAccounts.filter((a) => a.mailEmail === accountParam && a.provider === providerParam)
      : allAccounts;

  const perAccount = await Promise.all(
    accountsToFetch.map(async (acct) => {
      const adapter = adapterForAccount(acct);
      const result = await adapter.listInbox(toMailContext(user.id, acct), { pageToken, skip });
      if (result.ok) return result.data.messages;
      // Visible failure: capture but don't fail the whole request.
      Sentry.captureException(new Error(result.error.message), {
        tags: {
          area: "mail",
          op: "list_inbox",
          provider: acct.provider,
          transport: acct.via ?? "direct",
          code: result.error.code,
        },
      });
      return [] as MailMessage[];
    }),
  );

  const all = perAccount.flat().sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    return db - da;
  });

  return NextResponse.json({
    messages: all,
    accounts: allAccounts,
  });
}
