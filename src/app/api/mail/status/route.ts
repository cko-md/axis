import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts, projectMailAccount } from "@/lib/mail/tokens";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ accounts: [] });

  try {
    const accounts = await listMailAccounts(user.id);
    return NextResponse.json({ accounts: accounts.map(projectMailAccount) });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", route: "/api/mail/status", op: "list_accounts" },
    });
    return NextResponse.json(
      { accounts: [], error: "Mail account status could not be refreshed.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
}
