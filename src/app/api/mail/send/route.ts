import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getFreshMailAccessToken, listMailAccounts, type MailProvider } from "@/lib/mail/tokens";
import { sendComposioMail } from "@/lib/mail/composio";

interface SendPayload {
  to: string;
  subject: string;
  body: string;
  provider: MailProvider;
  mailEmail: string;
  inReplyTo?: string;
  references?: string;
}

function buildRfc2822(from: string, to: string, subject: string, body: string, inReplyTo?: string, references?: string): string {
  const lines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("", body);
  return lines.join("\r\n");
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendGmail(accessToken: string, raw: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: base64UrlEncode(raw) }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }
  return { ok: true };
}

async function sendOutlook(accessToken: string, to: string, subject: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }
  return { ok: true };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: SendPayload;
  try {
    payload = await req.json() as SendPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 422 });
  }

  const { to, subject, body, provider, mailEmail, inReplyTo, references } = payload;
  if (!to?.trim() || !subject?.trim() || !body?.trim() || !provider || !mailEmail) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 422 });
  }

  // Verify the account belongs to this user
  const accounts = await listMailAccounts(user.id);
  const account = accounts.find((a) => a.provider === provider && a.mailEmail === mailEmail);
  if (!account) return NextResponse.json({ error: "Account not connected" }, { status: 403 });

  if (account.via === "composio" && account.connectedAccountId) {
    const result = await sendComposioMail(provider, account.connectedAccountId, user.id, to, subject, body);
    if (!result.ok) return NextResponse.json({ error: `${provider} error: ${result.error ?? "unknown"}` }, { status: 502 });
    return NextResponse.json({ ok: true });
  }

  const accessToken = await getFreshMailAccessToken(user.id, provider, mailEmail);
  if (!accessToken) return NextResponse.json({ error: "Token unavailable — please reconnect your account" }, { status: 401 });

  if (provider === "gmail") {
    const raw = buildRfc2822(mailEmail, to, subject, body, inReplyTo, references);
    const result = await sendGmail(accessToken, raw);
    if (!result.ok) return NextResponse.json({ error: `Gmail error: ${result.error ?? "unknown"}` }, { status: 502 });
  } else {
    const result = await sendOutlook(accessToken, to, subject, body);
    if (!result.ok) return NextResponse.json({ error: `Outlook error: ${result.error ?? "unknown"}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
