import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";
import { findMailAccount } from "@/lib/mail/findAccount";
import { adapterForAccount, toMailContext, mailErrorStatus } from "@/lib/mail/adapters";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  ProviderTimeoutError,
  logRouteTiming,
  recordProviderFailure,
  timedProviderOperation,
} from "@/lib/observability/providerTiming";
import type { MailAttachment } from "@/lib/mail/gmail";

const LIBRARY_BUCKET = "library-files";

function safeFilename(name: string): string {
  return name
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "attachment";
}

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
  const accountId = req.nextUrl.searchParams.get("accountId");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Ownership: the account must belong to this user (and tells us the transport).
  let accounts;
  try {
    accounts = await listMailAccounts(user.id);
  } catch (error) {
    captureRouteError(error, {
      route: "/api/mail/message/[id]",
      operation: "list_accounts",
      area: "mail",
      provider,
      status: 503,
      code: "account_status_unavailable",
    });
    return NextResponse.json(
      { error: "Mail accounts could not be loaded. Message was not opened.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
  const account = findMailAccount(accounts, provider, email, accountId);
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

export async function POST(
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
  const accountId = req.nextUrl.searchParams.get("accountId");

  const body = await req.json().catch(() => ({})) as {
    action?: string;
    attachment?: Partial<MailAttachment>;
  };
  if (body.action !== "create-signal" && body.action !== "route-attachment-library") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }
  if (body.action === "route-attachment-library" && !body.attachment?.id) {
    return NextResponse.json({ error: "attachment.id is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let accounts;
  try {
    accounts = await listMailAccounts(user.id);
  } catch (error) {
    captureRouteError(error, {
      route: "/api/mail/message/[id]",
      operation: "list_accounts",
      area: "mail",
      provider,
      status: 503,
      code: "account_status_unavailable",
    });
    return NextResponse.json(
      { error: "Mail accounts could not be loaded. Message was not routed.", code: "account_status_unavailable" },
      { status: 503 },
    );
  }
  const account = findMailAccount(accounts, provider, email, accountId);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  const adapter = adapterForAccount(account);
  const transport = account.via === "composio" ? "composio" : "direct";
  const timing = {
    area: "mail",
    provider,
    transport,
    operation: body.action,
    timeoutMs: 10_000,
    slowMs: 2_500,
  };

  let result: Awaited<ReturnType<typeof adapter.getMessage>>;
  try {
    result = await timedProviderOperation(timing, () =>
      adapter.getMessage(toMailContext(user.id, account), id),
    );
  } catch (error) {
    const isTimeout = error instanceof ProviderTimeoutError;
    captureRouteError(error, {
      route: "/api/mail/message/[id]",
      operation: body.action,
      area: "mail",
      provider,
      transport,
      status: isTimeout ? 504 : 502,
      code: isTimeout ? "timeout" : "network",
    });
    logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
      provider,
      transport,
      ok: false,
      code: isTimeout ? "timeout" : "network",
    });
    return NextResponse.json(
      {
        error: isTimeout
          ? "Message took too long to route. Try again in a moment."
          : "Message could not be routed. Try again in a moment.",
        code: isTimeout ? "timeout" : "network",
      },
      { status: isTimeout ? 504 : 502 },
    );
  }

  if (!result.ok) {
    const status = mailErrorStatus(result.error.code);
    if (status >= 500) {
      captureRouteError(new Error(result.error.message), {
        route: "/api/mail/message/[id]",
        operation: body.action,
        area: "mail",
        provider,
        transport,
        status,
        code: result.error.code,
      });
    }
    logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
      provider,
      transport,
      ok: false,
      code: result.error.code,
    });
    return NextResponse.json({ error: result.error.message, code: result.error.code }, { status });
  }

  const attachment = body.action === "route-attachment-library" ? body.attachment : undefined;
  if (attachment?.id) {
    const attachmentResult = await adapter.getAttachment(toMailContext(user.id, account), id, attachment.id);
    if (attachmentResult.ok) {
      const file = attachmentResult.data;
      const displayName = safeFilename(file.filename);
      const storagePath = `${user.id}/mail-attachments/${crypto.randomUUID()}-${displayName}`;
      const { error: uploadError } = await supabase.storage
        .from(LIBRARY_BUCKET)
        .upload(storagePath, file.bytes, {
          contentType: file.mimeType,
          upsert: false,
        });

      if (uploadError) {
        captureRouteError(uploadError, {
          route: "/api/mail/message/[id]",
          operation: "save_attachment_to_library_storage",
          area: "mail",
          provider: "supabase",
          status: 500,
        });
        return NextResponse.json({ error: "Attachment downloaded, but Library storage failed." }, { status: 500 });
      }

      const { data: libraryFile, error: insertError } = await supabase
        .from("library_files")
        .insert({
          user_id: user.id,
          storage_path: storagePath,
          display_name: displayName,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes ?? file.bytes.byteLength,
          collection: 0,
        })
        .select()
        .single();

      if (insertError || !libraryFile) {
        await supabase.storage.from(LIBRARY_BUCKET).remove([storagePath]);
        captureRouteError(insertError, {
          route: "/api/mail/message/[id]",
          operation: "save_attachment_to_library_metadata",
          area: "mail",
          provider: "supabase",
          status: 500,
        });
        return NextResponse.json({ error: "Attachment downloaded, but Library metadata failed." }, { status: 500 });
      }

      logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
        provider,
        transport,
        ok: true,
        operation: "save_attachment_to_library",
      });
      return NextResponse.json({ libraryFile, saved: true });
    }

    if (mailErrorStatus(attachmentResult.error.code) !== 501) {
      const status = mailErrorStatus(attachmentResult.error.code);
      if (status >= 500) {
        captureRouteError(new Error(attachmentResult.error.message), {
          route: "/api/mail/message/[id]",
          operation: "download_mail_attachment",
          area: "mail",
          provider,
          transport,
          status,
          code: attachmentResult.error.code,
        });
      }
      return NextResponse.json({ error: attachmentResult.error.message, code: attachmentResult.error.code }, { status });
    }
  }

  const message = result.data;
  const sourceObject = {
    source_object_type: attachment ? "mail_attachment" : "mail_message",
    source_object_id: attachment ? `${id}:${attachment.id}` : id,
    source_route: "/mail",
    mail_provider: provider,
    mail_transport: transport,
    mail_account_email: email,
    mail_thread_id: message.threadId ?? null,
    mail_message_id: id,
    attachment_id: attachment?.id ?? null,
    attachment_filename: attachment?.filename ?? null,
    attachment_mime_type: attachment?.mimeType ?? null,
    attachment_size_bytes: attachment?.sizeBytes ?? null,
  };

  const { data: existing, error: existingError } = await supabase
    .from("signals")
    .select("*")
    .eq("user_id", user.id)
    .contains("metadata", {
      source_object_type: sourceObject.source_object_type,
      source_object_id: sourceObject.source_object_id,
      mail_provider: provider,
      mail_account_email: email,
    })
    .maybeSingle();

  if (existingError) {
    captureRouteError(existingError, {
      route: "/api/mail/message/[id]",
      operation: "lookup_existing_signal",
      area: "mail",
      provider: "supabase",
      status: 500,
    });
    return NextResponse.json({ error: "Could not check existing Dispatch signal." }, { status: 500 });
  }

  if (existing) {
    return NextResponse.json({ signal: existing, existing: true });
  }

  const { data: signal, error: insertError } = await supabase
    .from("signals")
    .insert({
      user_id: user.id,
      title: attachment?.filename
        ? `Save attachment: ${attachment.filename}`
        : message.subject || "Mail signal",
      body: attachment?.filename
        ? `From: ${message.from}\nSubject: ${message.subject || "(no subject)"}\nAttachment: ${attachment.filename}\nType: ${attachment.mimeType ?? "unknown"}\n\nRoute this mail attachment into Library when the provider download is available.`
        : `From: ${message.from}\nDate: ${message.date}\n\n${message.snippet || "No preview available."}`,
      source: "Mail",
      signal_type: "action",
      route_target: attachment ? "library" : "agenda",
      metadata: sourceObject,
    })
    .select()
    .single();

  if (insertError || !signal) {
    captureRouteError(insertError, {
      route: "/api/mail/message/[id]",
      operation: "insert_signal",
      area: "mail",
      provider: "supabase",
      status: 500,
    });
    return NextResponse.json({ error: "Could not create Dispatch signal." }, { status: 500 });
  }

  logRouteTiming("/api/mail/message/[id]", routeStartedAt, {
    provider,
    transport,
    ok: true,
    operation: body.action,
  });
  return NextResponse.json({ signal, existing: false });
}
