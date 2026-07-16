import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { readMailCache, readMailSyncState } from "@/lib/mail/cache";
import { logRouteTiming } from "@/lib/observability/providerTiming";

// Cache-only inbox read. Provider refreshes are explicit POSTs to
// /api/mail/sync, so first paint never waits on Gmail, Outlook, or Composio.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const accountEmail = req.nextUrl.searchParams.get("account") ?? undefined;
  const provider = req.nextUrl.searchParams.get("provider");
  const mailProvider: "gmail" | "outlook" | undefined = provider === "gmail" || provider === "outlook"
    ? provider
    : undefined;
  const account = accountEmail && mailProvider
    ? { provider: mailProvider, mailEmail: accountEmail }
    : undefined;

  try {
    const [accounts, cache, syncState] = await Promise.all([
      listMailAccounts(user.id),
      readMailCache(supabase, user.id, account),
      readMailSyncState(supabase, user.id),
    ]);
    logRouteTiming("/api/mail/inbox", routeStartedAt, {
      source: "cache",
      accounts: accounts.length,
      messages: cache.messages.length,
    });
    return NextResponse.json({
      messages: cache.messages,
      accounts,
      syncState,
      fetchedAt: cache.fetchedAt,
      fromCache: true,
      hasMore: false,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", route: "/api/mail/inbox", op: "read_cache" },
    });
    logRouteTiming("/api/mail/inbox", routeStartedAt, {
      source: "cache",
      accounts: 0,
      messages: 0,
      partial: true,
      code: "cache_unavailable",
    });
    return NextResponse.json(
      { error: "The saved inbox could not be loaded.", code: "cache_unavailable" },
      { status: 503 },
    );
  }
}
