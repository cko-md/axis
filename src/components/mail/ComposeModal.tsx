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
  inReplyTo?: string;
  references?: string;
}

interface MailAccount {
  provider: "gmail" | "outlook";
  mailEmail: string;
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
  const [to, setTo] = useState(draft.to ?? "");
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body ?? "");
  const [provider, setProvider] = useState<MailProvider>(draft.provider ?? accounts[0]?.provider ?? "gmail");
  const [mailEmail, setMailEmail] = useState(draft.mailEmail ?? accounts[0]?.mailEmail ?? "");
  const [sending, setSending] = useState(false);

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
          inReplyTo: draft.inReplyTo,
          references: draft.references,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        toast("Message sent.", "success", "Mail");
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
                value={`${provider}:${mailEmail}`}
                onChange={(e) => {
                  const [p, m] = e.target.value.split(":") as [MailProvider, string];
                  setProvider(p);
                  setMailEmail(m);
                }}
                style={{ ...inputStyle, cursor: "pointer" }}
              >
                {accounts.map((a) => (
                  <option key={`${a.provider}:${a.mailEmail}`} value={`${a.provider}:${a.mailEmail}`}>
                    {a.mailEmail} ({a.provider})
                  </option>
                ))}
              </select>
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
