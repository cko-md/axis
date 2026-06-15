import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { listGmailInbox, type MailMessage } from "@/lib/mail/gmail";
import { listOutlookInbox } from "@/lib/mail/outlook";

// GET /api/mail/inbox
// Optional per-account pagination: ?account=email@x.com&provider=gmail&pageToken=...&skip=0
// Without those params: fetches page 1 for all connected accounts.
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

  // If a specific account is requested, only fetch that one
  const accountsToFetch =
    accountParam && providerParam
      ? allAccounts.filter(
          (a) => a.mailEmail === accountParam && a.provider === providerParam,
        )
      : allAccounts;

  const settled = await Promise.allSettled(
    accountsToFetch.map(async (acct) => {
      if (acct.provider === "gmail") {
        const r = await listGmailInbox(user.id, acct.mailEmail, pageToken);
        return r.messages;
      } else {
        const r = await listOutlookInbox(user.id, acct.mailEmail, skip);
        return r.messages;
      }
    }),
  );
  const results = settled
    .filter((r): r is PromiseFulfilledResult<MailMessage[]> => r.status === "fulfilled")
    .map((r) => r.value);

  const all = results.flat().sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    return db - da;
  });

  return NextResponse.json({
    messages: all,
    accounts: allAccounts,
  });
}
