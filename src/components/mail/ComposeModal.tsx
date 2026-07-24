"use client";

import { useState } from "react";
import type { MailProvider } from "@/lib/mail/tokens";
import { useToast } from "@/components/ui/Toast";

export interface ComposeDraft {
  to?: string;
  subject?: string;
  body?: string;
  provider?: MailProvider;
  mailEmail?: string;
  via?: "direct" | "composio";
  connectionId?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

interface MailAccount {
  provider: "gmail" | "outlook";
  mailEmail: string;
  via?: "composio";
  connectionId?: string;
}

type TransportHint = "direct" | "composio";

function accountTransport(account: MailAccount): TransportHint {
  return account.via === "composio" ? "composio" : "direct";
}

function accountKey(account: MailAccount): string {
  return `${account.provider}|${accountTransport(account)}|${account.mailEmail}|${account.connectionId ?? ""}`;
}

function accountLabel(account: MailAccount): string {
  const transport = accountTransport(account) === "composio" ? "Composio" : "Direct";
  return `${account.mailEmail} (${account.provider}, ${transport})`;
}

export function ComposeModal({
  draft,
  accounts,
  onClose,
  onSent,
}: {
  draft: ComposeDraft;
  accounts: MailAccount[];
  onClose: () => void;
  onSent: () => void;
}) {
  const { toast } = useToast();
  const fallbackAccount = accounts[0];
  const draftTransport = draft.via ?? (fallbackAccount ? accountTransport(fallbackAccount) : "direct");
  const initialAccount =
    accounts.find(
      (a) =>
        a.provider === draft.provider &&
        a.mailEmail === draft.mailEmail &&
        accountTransport(a) === draftTransport,
    ) ??
    accounts.find((a) => a.provider === draft.provider && a.mailEmail === draft.mailEmail) ??
    fallbackAccount;
  const isReply = !!draft.inReplyTo;
  const [to, setTo] = useState(draft.to ?? "");
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body ?? "");
  const [provider, setProvider] = useState<MailProvider>(initialAccount?.provider ?? draft.provider ?? "gmail");
  const [mailEmail, setMailEmail] = useState(initialAccount?.mailEmail ?? draft.mailEmail ?? "");
  const [via, setVia] = useState<TransportHint>(
    initialAccount ? accountTransport(initialAccount) : draft.via ?? "direct",
  );
  const [connectionId, setConnectionId] = useState(initialAccount?.connectionId ?? draft.connectionId ?? "");
  const [sending, setSending] = useState(false);
  const accountMissing = !accounts.some(
    (a) => a.provider === provider && a.mailEmail === mailEmail && accountTransport(a) === via && a.connectionId === connectionId,
  );
  const composioReplyFallback = isReply && via === "composio";

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--surface-2)",
    border: "1px solid var(--line)",
    borderRadius: 4,
    color: "var(--ink)",
    fontSize: "13px",
    padding: "6px 10px",
    outline: "none",
    fontFamily: "inherit",
  };

  const send = async () => {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast("To, Subject, and Body are required.", "error", "Mail");
      return;
    }
    if (!mailEmail || accountMissing) {
      toast("Choose a connected sending account.", "error", "Mail");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          subject,
          body,
          provider,
          mailEmail,
          via,
          connectionId,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          threadId: draft.threadId,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string };
      if (res.ok && data.ok) {
        toast(data.warning ?? "Message sent.", data.warning ? "info" : "success", "Mail");
        onSent();
      } else {
        toast(data.error ?? "Send failed.", "error", "Mail");
      }
    } catch {
      toast("Network error — message not sent.", "error", "Mail");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Compose message"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line-strong)",
          borderRadius: 10,
          width: "100%",
          maxWidth: 560,
          display: "flex",
          flexDirection: "column",
          gap: 0,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--ink)" }}>
            {draft.inReplyTo ? "Reply" : "New Message"}
          </span>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--ink-dim)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        {/* Fields */}
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* From account selector */}
          {accounts.length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 11, color: "var(--ink-faint)", width: 52, flexShrink: 0, fontFamily: "var(--font-mono, monospace)" }}>FROM</label>
              <select
                value={`${provider}|${via}|${mailEmail}|${connectionId}`}
                disabled={isReply}
                onChange={(e) => {
                  const account = accounts.find((a) => accountKey(a) === e.target.value);
                  if (!account) return;
                  setProvider(account.provider);
                  setMailEmail(account.mailEmail);
                  setVia(accountTransport(account));
                  setConnectionId(account.connectionId ?? "");
                }}
                style={{ ...inputStyle, cursor: isReply ? "default" : "pointer", opacity: isReply ? 0.75 : 1 }}
              >
                {accounts.map((a) => (
                  <option key={accountKey(a)} value={accountKey(a)}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {accounts.length <= 1 && mailEmail && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 11, color: "var(--ink-faint)", width: 52, flexShrink: 0, fontFamily: "var(--font-mono, monospace)" }}>FROM</label>
              <div style={{ ...inputStyle, color: "var(--ink-dim)" }}>
                {mailEmail} ({provider}, {via === "composio" ? "Composio" : "Direct"})
              </div>
            </div>
          )}
          {composioReplyFallback && (
            <div
              role="status"
              style={{
                border: "1px solid var(--line)",
                background: "var(--surface-2)",
                borderRadius: 6,
                color: "var(--ink-dim)",
                fontSize: "12px",
                lineHeight: 1.5,
                padding: "8px 10px",
              }}
            >
              Composio can send this reply, but native thread attachment is not verified yet. It will be sent as a new message with the reply subject and quote.
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 11, color: "var(--ink-faint)", width: 52, flexShrink: 0, fontFamily: "var(--font-mono, monospace)" }}>TO</label>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" style={inputStyle} autoFocus={!draft.to} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 11, color: "var(--ink-faint)", width: 52, flexShrink: 0, fontFamily: "var(--font-mono, monospace)" }}>SUBJ</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" style={inputStyle} />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
            rows={8}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
            autoFocus={!!draft.to}
          />
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
          <button type="button" onClick={onClose} style={{ padding: "6px 14px", borderRadius: 5, background: "var(--surface-2)", border: "1px solid var(--line)", color: "var(--ink-dim)", fontSize: "12px", cursor: "pointer" }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending}
            style={{ padding: "6px 16px", borderRadius: "var(--r)", background: "var(--accent)", border: "none", color: "var(--on-accent)", fontSize: "12px", fontWeight: 600, cursor: sending ? "default" : "pointer", opacity: sending ? 0.7 : 1 }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
