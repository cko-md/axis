import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMailAccounts, projectMailAccount, projectMailMessage } from "@/lib/mail/tokens";
import { readMailCache, readMailSyncState } from "@/lib/mail/cache";
import { logRouteTiming } from "@/lib/observability/providerTiming";

// Cache-only inbox read. Provider refreshes are explicit POSTs to
// /api/mail/sync, so first paint never waits on Gmail, Outlook, or Composio.
export async function GET(req: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    Sentry.captureException(new Error("Mail inbox authentication failed"), {
      tags: { area: "mail", route: "/api/mail/inbox", op: "authenticate" },
    });
    return NextResponse.json({ error: "Authentication is temporarily unavailable." }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Saved inbox authority is unavailable.", code: "identity_unavailable" }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get("connectionId") ?? undefined;
  const accountEmail = req.nextUrl.searchParams.get("account") ?? undefined;
  const provider = req.nextUrl.searchParams.get("provider");
  const mailProvider: "gmail" | "outlook" | undefined = provider === "gmail" || provider === "outlook"
    ? provider
    : undefined;
  if ((accountEmail !== undefined) !== (mailProvider !== undefined)) {
    return NextResponse.json({ error: "account and provider must be supplied together" }, { status: 400 });
  }
  if ((accountEmail || mailProvider) && !connectionId) {
    return NextResponse.json({ error: "connectionId is required for a mailbox selector" }, { status: 400 });
  }

  try {
    const accounts = await listMailAccounts(user.id, { verifyRemote: false });
    const selected = connectionId
      ? accounts.filter((candidate) => candidate.connectionId === connectionId)
      : [];
    if (connectionId && selected.length !== 1) {
      return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
    }
    const account = selected[0];
    if (account && (
      (accountEmail !== undefined && account.mailEmail !== accountEmail)
      || (mailProvider !== undefined && account.provider !== mailProvider)
    )) {
      return NextResponse.json({ error: "Mailbox selector does not match the connected mailbox" }, { status: 400 });
    }
    const [cache, syncState] = await Promise.all([
      readMailCache(admin, user.id, account),
      readMailSyncState(admin, user.id),
    ]);
    logRouteTiming("/api/mail/inbox", routeStartedAt, {
      source: "cache",
      accounts: accounts.length,
      messages: cache.messages.length,
    });
    return NextResponse.json({
      messages: cache.messages.map((message) => projectMailMessage(message)),
      accounts: accounts.map(projectMailAccount),
      syncState,
      fetchedAt: cache.fetchedAt,
      fromCache: true,
      hasMore: false,
    });
  } catch {
    Sentry.captureException(new Error("Mail inbox cache read failed"), {
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
