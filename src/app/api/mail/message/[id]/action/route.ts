import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts, type MailProvider } from "@/lib/mail/tokens";
import { findMailAccount } from "@/lib/mail/findAccount";
import { readBoundedJson } from "@/lib/http/boundedJson";

type MailMessageAction = "mark-read" | "mark-unread" | "archive" | "delete";
function isMailAction(value: unknown): value is MailMessageAction {
  return value === "mark-read" || value === "mark-unread" || value === "archive" || value === "delete";
}
function isProvider(value: unknown): value is MailProvider { return value === "gmail" || value === "outlook"; }

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_000) return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  const body = await readBoundedJson(req, 16_000).catch(() => null) as { action?: unknown; provider?: unknown; email?: unknown; accountId?: unknown } | null;
  if (!body || !isMailAction(body.action) || !isProvider(body.provider) || typeof body.email !== "string" || !body.email) {
    return NextResponse.json({ error: "action, provider, and email are required" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  let accounts;
  try { accounts = await listMailAccounts(user.id); } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error("Mail account lookup failed"), { tags: { area: "mail", route: "message_action", op: "list_accounts" } });
    return NextResponse.json({ error: "Mail accounts could not be loaded. Message was not changed." }, { status: 503 });
  }
  const account = findMailAccount(accounts, body.provider, body.email, typeof body.accountId === "string" ? body.accountId : null);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });
  return NextResponse.json({ ok: false, state: "failed_before_dispatch", retryable: false, error: `This ${body.action} action is not yet available for the connected Composio account. No change was made.` }, { status: 422 });
}
