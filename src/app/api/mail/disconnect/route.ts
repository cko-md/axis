import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { deleteMailTokens, type MailProvider } from "@/lib/mail/tokens";
import { deleteMailCacheForAccount } from "@/lib/mail/cache";

// DELETE /api/mail/disconnect?provider=gmail|outlook&email=user@example.com
export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") as MailProvider | null;
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

  const error = await deleteMailTokens(user.id, provider, email);
  if (error) {
    Sentry.captureException(error, {
      tags: { area: "mail", operation: "disconnect", provider, transport: "direct" },
    });
    return NextResponse.json({ error: "Could not disconnect mailbox" }, { status: 500 });
  }
  try {
    await deleteMailCacheForAccount(supabase, user.id, { provider, mailEmail: email });
  } catch (cacheError) {
    Sentry.captureException(cacheError, {
      tags: { area: "mail", operation: "disconnect_cache_cleanup", provider, transport: "direct" },
    });
    return NextResponse.json(
      { error: "Mailbox disconnected, but saved inbox cleanup failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
