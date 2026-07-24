import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMailAccounts, type MailProvider } from "@/lib/mail/tokens";
import { createProviderMutationKernel } from "@/lib/mutations/providerMutationKernel";
import { createSupabaseProviderMutationStore } from "@/lib/mutations/providerMutationStore";
import { providerMutationSemanticHash } from "@/lib/mutations/semanticHash";
import { providerMutationResponse } from "@/lib/mutations/httpResponse";
import { readBoundedJson } from "@/lib/http/boundedJson";

interface SendPayload {
  to: string;
  subject: string;
  body: string;
  provider: MailProvider;
  mailEmail: string;
  via?: "direct" | "composio";
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  idempotencyKey?: string;
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    || /^[0-9a-f]{64}$/i.test(value)
  );
}

// POST /api/mail/send
// Composio's currently verified mail-send tool has no stable sent-message ID
// or read-after-write reconciliation hook. Sending would therefore turn a
// timeout into an unsafe duplicate-send choice. We persist an honest failed
// pre-dispatch command and fail closed until the provider adapter can supply a
// durable acknowledgement receipt plus reconciliation contract.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 128_000) {
    return NextResponse.json({ error: "Request body is too large" }, { status: 413 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "Authentication service unavailable" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: SendPayload;
  try {
    payload = (await readBoundedJson(req, 128_000)) as SendPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 422 });
  }

  const { to, subject, body, provider, mailEmail, via, inReplyTo, references, threadId, idempotencyKey } = payload;
  if (!to?.trim() || !subject?.trim() || !body?.trim() || !provider || !mailEmail) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 422 });
  }
  if (via && via !== "composio") {
    return NextResponse.json({ error: "Unsupported mail transport" }, { status: 422 });
  }
  if (!validIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: "A valid idempotency key is required" }, { status: 422 });
  }

  let accounts;
  try {
    accounts = await listMailAccounts(user.id);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error("Mail account lookup failed"), {
      tags: { area: "mail", route: "/api/mail/send", op: "list_accounts" },
    });
    return NextResponse.json({ error: "Mail accounts could not be loaded. Nothing was sent." }, { status: 503 });
  }
  const account = accounts.find((candidate) =>
    candidate.provider === provider && candidate.mailEmail === mailEmail && (!via || candidate.via === via),
  );
  if (!account) {
    return NextResponse.json({ error: "Account not connected" }, { status: 403 });
  }

  if (!account.connectedAccountId) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  let semanticHash: string;
  try {
    semanticHash = providerMutationSemanticHash({
      userId: user.id, provider, connectionRef: account.connectedAccountId,
      to, subject, body, inReplyTo: inReplyTo ?? null, references: references ?? null, threadId: threadId ?? null,
    });
  } catch {
    return NextResponse.json({ error: "The protected mutation service is unavailable. Nothing was sent." }, { status: 503 });
  }
  const kernel = createProviderMutationKernel({
    store: createSupabaseProviderMutationStore(createAdminClient()),
  });
  const result = await kernel.execute({
    userId: user.id,
    idempotencyKey,
    kind: inReplyTo ? "mail_reply" : "mail_send",
    provider,
    transport: "composio",
    connectionRef: account.connectedAccountId,
    semanticHash,
    preflight: async () => ({ permitted: false, errorCode: "invalid_operation" }),
    // The preflight above is intentionally false. This callback is a proof
    // obligation: it must never be reached until a provider receipt contract
    // exists, and is kept explicit so a future enabling change is reviewable.
    dispatch: async () => {
      throw new Error("mail send dispatch is disabled without durable receipt reconciliation");
    },
  });
  return providerMutationResponse(result);
}
