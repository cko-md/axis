import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { adapterForAccount, toMailContext, mailErrorStatus } from "@/lib/mail/adapters";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";

// GET /api/mail/message/[id]?provider=gmail|outlook&email=user@example.com
// Provider/transport selection is delegated to the mail adapter — this route
// works identically for direct-OAuth and Composio accounts.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const routeStartedAt = Date.now();
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
  const transport = account.via === "composio" ? "composio" : "direct";
  const timing = {
    area: "mail",
    provider,
    transport,
    operation: "get_message",
    timeoutMs: 10_000,
    slowMs: 2_500,
  };
  const providerStartedAt = Date.now();
  let result: Awaited<ReturnType<typeof adapter.getMessage>>;
  try {
    result = await timedProviderOperation(timing, () =>
      adapter.getMessage(toMailContext(user.id, account), id),
    );
  } catch (error) {
    const isTimeout = error instanceof ProviderTimeoutError;
    logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
      provider,
      transport,
      ok: false,
      code: isTimeout ? "timeout" : "network",
    });
    return NextResponse.json(
      {
        error: isTimeout
          ? "Message took too long to load. Try again in a moment."
          : "Message could not be loaded. Try again in a moment.",
        code: isTimeout ? "timeout" : "network",
      },
      { status: isTimeout ? 504 : 502 },
    );
  }

  if (result.ok) {
    logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
      provider,
      transport,
      ok: true,
    });
    return NextResponse.json(result.data);
  }

  const status = mailErrorStatus(result.error.code);
  recordProviderFailure(
    timing,
    {
      code: result.error.code,
      message: result.error.message,
      status: result.error.status ?? status,
    },
    Date.now() - providerStartedAt,
  );
  logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
    provider,
    transport,
    ok: false,
    code: result.error.code,
  });
  return NextResponse.json({ error: result.error.message, code: result.error.code }, { status });
}
