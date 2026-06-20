"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { MailMessage, MailMessageFull } from "@/lib/mail/gmail";
import type { MailProvider } from "@/lib/mail/tokens";
import { useToast } from "@/components/ui/Toast";
import { openOAuthPopup } from "@/lib/auth/openOAuthPopup";

interface MailAccount {
  provider: "gmail" | "outlook";
  mailEmail: string;
}

type SortMode = "date" | "priority";
type AccountFilter = "all" | string; // "all" or a specific mailEmail

// ─── helpers ────────────────────────────────────────────────────────────────

function priorityScore(msg: MailMessage): number {
  const ageHours = (Date.now() - new Date(msg.date).getTime()) / 3600000;
  return (msg.isUnread ? 50 : 0) + Math.max(0, 100 - ageHours);
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function parseSenderName(from: string): string {
  const match = from.match(/^([^<]+)</);
  if (match) return match[1].trim();
  return from.replace(/<[^>]+>/, "").trim() || from;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

function abbreviateEmail(email: string, maxLen = 12): string {
  const atIdx = email.indexOf("@");
  if (atIdx === -1) return email.slice(0, maxLen);
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx); // includes @
  const combined = local + domain;
  if (combined.length <= maxLen) return combined;
  // truncate local part
  const truncated = local.slice(0, Math.max(1, maxLen - domain.length));
  return truncated + domain;
}

// ─── types ──────────────────────────────────────────────────────────────────

interface ComposeDraft {
  to?: string;
  subject?: string;
  body?: string;
  provider?: MailProvider;
  mailEmail?: string;
  inReplyTo?: string;
  references?: string;
}

// ─── sub-components ─────────────────────────────────────────────────────────

function ProviderDot({ provider }: { provider: "gmail" | "outlook" }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: provider === "gmail" ? "#ea4335" : "#0078d4",
        flexShrink: 0,
      }}
    />
  );
}

function ProviderBadge({ provider }: { provider: "gmail" | "outlook" }) {
  return (
    <span
      style={{
        fontSize: "10px",
        fontWeight: 600,
        letterSpacing: "0.05em",
        padding: "1px 5px",
        borderRadius: "3px",
        background: provider === "gmail" ? "rgba(234,67,53,0.12)" : "rgba(0,120,212,0.12)",
        color: provider === "gmail" ? "#ea4335" : "#0078d4",
        flexShrink: 0,
      }}
    >
      {provider === "gmail" ? "Gmail" : "Outlook"}
    </span>
  );
}

function MessageRow({
  msg,
  selected,
  onClick,
}: {
  msg: MailMessage;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "8px 1fr auto",
        gridTemplateRows: "auto auto",
        gap: "0 10px",
        width: "100%",
        padding: "12px 16px",
        textAlign: "left",
        background: selected ? "var(--glass)" : "transparent",
        border: "none",
        borderBottom: "1px solid var(--line)",
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "var(--glass)";
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {/* Unread dot */}
      <span
        style={{
          gridRow: "1",
          gridColumn: "1",
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: msg.isUnread ? "var(--accent)" : "transparent",
          marginTop: 5,
          flexShrink: 0,
          alignSelf: "start",
        }}
      />
      {/* Sender + subject */}
      <span style={{ gridRow: "1", gridColumn: "2", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: "13px",
            fontWeight: msg.isUnread ? 600 : 400,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {parseSenderName(msg.from) || "Unknown"}
        </span>
        <span
          style={{
            fontSize: "12px",
            fontWeight: msg.isUnread ? 500 : 400,
            color: msg.isUnread ? "var(--ink)" : "var(--ink-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {msg.subject}
        </span>
        <span
          style={{
            fontSize: "12px",
            color: "var(--ink-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {msg.snippet}
        </span>
      </span>
      {/* Date + provider */}
      <span
        style={{
          gridRow: "1",
          gridColumn: "3",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "11px", color: "var(--ink-dim)", whiteSpace: "nowrap" }}>
          {formatDate(msg.date)}
        </span>
        <ProviderBadge provider={msg.provider} />
      </span>
    </button>
  );
}

function ComposeModal({
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
            style={{ padding: "6px 16px", borderRadius: 5, background: "var(--accent)", border: "none", color: "#000", fontSize: "12px", fontWeight: 600, cursor: sending ? "default" : "pointer", opacity: sending ? 0.7 : 1 }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MessagePanel({
  message,
  onClose,
  onReply,
}: {
  message: MailMessageFull;
  onClose: () => void;
  onReply?: (draft: ComposeDraft) => void;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  const summarize = async () => {
    setSummarizing(true);
    try {
      const body = message.bodyIsHtml ? stripHtml(message.body) : message.body;
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "triage", title: message.subject, body: body.slice(0, 4000) }),
      });
      if (res.ok) {
        const data = await res.json();
        setSummary(
          data?.title
            ? `${data.title} · ${data.category ?? ""} · Priority: ${data.priority ?? "med"}`
            : "Could not summarize.",
        );
      }
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--surface, #0f0f0f)",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--ink-dim)",
            cursor: "pointer",
            padding: "4px 0",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          ← Back
        </button>
        <span style={{ flex: 1 }} />
        <ProviderBadge provider={message.provider} />
        {onReply && (
          <button
            type="button"
            onClick={() => {
              const fromMatch = message.from.match(/<([^>]+)>/);
              const replyTo = fromMatch ? fromMatch[1] : message.from;
              const replySubject = message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`;
              const quotedBody = `\n\n---\nOn ${new Date(message.date).toLocaleString()}, ${message.from} wrote:\n${(message.bodyIsHtml ? stripHtml(message.body) : message.body).slice(0, 1000)}`;
              onReply({
                to: replyTo,
                subject: replySubject,
                body: quotedBody,
                provider: message.provider as MailProvider,
                mailEmail: message.accountEmail,
                inReplyTo: message.id,
              });
            }}
            style={{
              background: "var(--glass)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--ink)",
              fontSize: "12px",
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            ↩ Reply
          </button>
        )}
        <button
          type="button"
          onClick={summarize}
          disabled={summarizing}
          style={{
            background: "var(--glass)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            color: "var(--ink)",
            fontSize: "12px",
            padding: "5px 10px",
            cursor: summarizing ? "default" : "pointer",
            opacity: summarizing ? 0.6 : 1,
          }}
        >
          {summarizing ? "Triaging…" : "AI Triage"}
        </button>
      </div>

      {/* Summary banner */}
      {summary && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--accent-subtle)",
            borderBottom: "1px solid var(--line)",
            fontSize: "12px",
            color: "var(--ink)",
          }}
        >
          {summary}
        </div>
      )}

      {/* Message meta */}
      <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
        <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>
          {message.subject}
        </div>
        <div style={{ fontSize: "12px", color: "var(--ink-dim)" }}>
          <span style={{ color: "var(--ink)" }}>From:</span> {message.from}
        </div>
        <div style={{ fontSize: "12px", color: "var(--ink-dim)", marginTop: 2 }}>
          {new Date(message.date).toLocaleString()}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        {message.bodyIsHtml ? (
          <div
            style={{ fontSize: "13px", color: "var(--ink)", lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: message.body }}
          />
        ) : (
          <pre
            style={{
              fontFamily: "inherit",
              fontSize: "13px",
              color: "var(--ink)",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              margin: 0,
            }}
          >
            {message.body || message.snippet}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── AddAccountPicker ────────────────────────────────────────────────────────

function AddAccountPicker({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        zIndex: 20,
        background: "var(--surface, #181818)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "6px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 160,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/mail/connect?provider=gmail", (_provider, status) => {
            if (status === "ok") onConnected();
          });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: 5,
          background: "none",
          border: "none",
          color: "var(--ink)",
          fontSize: "13px",
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
      >
        <ProviderDot provider="gmail" /> Gmail
      </button>
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/mail/connect?provider=outlook", (_provider, status) => {
            if (status === "ok") onConnected();
          });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: 5,
          background: "none",
          border: "none",
          color: "var(--ink)",
          fontSize: "13px",
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
      >
        <ProviderDot provider="outlook" /> Outlook
      </button>
      <button
        type="button"
        onClick={onClose}
        style={{
          padding: "6px 10px",
          borderRadius: 5,
          background: "none",
          border: "none",
          color: "var(--ink-dim)",
          fontSize: "12px",
          cursor: "pointer",
          textAlign: "center",
        }}
      >
        Cancel
      </button>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function MailModule() {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MailMessageFull | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("date");
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("all");
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const mountedRef = useRef(true);
  const addBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Close picker on outside click
  useEffect(() => {
    if (!showAddPicker) return;
    const handler = (e: MouseEvent) => {
      if (addBtnRef.current && !addBtnRef.current.contains(e.target as Node)) {
        setShowAddPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAddPicker]);

  useEffect(() => {
    fetch("/api/mail/status")
      .then((r) => r.json())
      .then((s: { accounts: MailAccount[] }) => {
        if (mountedRef.current) {
          setAccounts(s.accounts ?? []);
          setStatusLoaded(true);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setAccounts([]);
          setStatusLoaded(true);
        }
      });
  }, []);

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mail/inbox");
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      setMessages(data.messages ?? []);
      // Refresh accounts list from response
      if (data.accounts) setAccounts(data.accounts);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const refreshMailStatus = useCallback(() => {
    fetch("/api/mail/status")
      .then((r) => r.json())
      .then((s: { accounts: MailAccount[] }) => {
        if (mountedRef.current) setAccounts(s.accounts ?? []);
      })
      .catch(() => {});
  }, []);

  const isConnected = statusLoaded && accounts.length > 0;

  useEffect(() => {
    if (isConnected) fetchInbox();
  }, [isConnected, fetchInbox]);

  // Handle ?connected=gmail|outlook on return from OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected) {
      window.history.replaceState({}, "", "/mail");
      // Re-fetch status to pick up the new account
      fetch("/api/mail/status")
        .then((r) => r.json())
        .then((s: { accounts: MailAccount[] }) => {
          if (mountedRef.current) setAccounts(s.accounts ?? []);
        })
        .catch(() => {});
    }
  }, []);

  const openMessage = async (msg: MailMessage) => {
    setLoadingMsg(true);
    try {
      const res = await fetch(
        `/api/mail/message/${msg.id}?provider=${msg.provider}&email=${encodeURIComponent(msg.accountEmail)}`,
      );
      if (res.ok && mountedRef.current) setSelected(await res.json());
    } finally {
      if (mountedRef.current) setLoadingMsg(false);
    }
  };

  const disconnect = async (acct: MailAccount) => {
    const res = await fetch(
      `/api/mail/disconnect?provider=${acct.provider}&email=${encodeURIComponent(acct.mailEmail)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      toast("Failed to disconnect account. Try again.", "error", "Mail");
      return;
    }
    setAccounts((prev) =>
      prev.filter((a) => !(a.provider === acct.provider && a.mailEmail === acct.mailEmail)),
    );
    setMessages((prev) => prev.filter((m) => m.accountEmail !== acct.mailEmail));
    if (accountFilter === acct.mailEmail) setAccountFilter("all");
  };

  // Filter + sort
  const visibleMessages = (() => {
    let list = accountFilter === "all"
      ? messages
      : messages.filter((m) => m.accountEmail === accountFilter);

    if (sortMode === "priority") {
      list = [...list].sort((a, b) => priorityScore(b) - priorityScore(a));
    }
    return list;
  })();

  const unreadCount = visibleMessages.filter((m) => m.isUnread).length;

  // Setup state — no accounts yet
  if (statusLoaded && !isConnected) {
    return (
      <>
        <div className="divider" />
        <div className="setup-state" data-svc="mail">
          <div className="setup-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3 7l9 6 9-6" />
            </svg>
          </div>
          <div className="setup-t">Connect a mailbox</div>
          <div className="setup-d">
            Link Gmail or Outlook (read-only) to triage, summarize, and route mail.
            Tokens are encrypted server-side — never stored in the browser.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="setup-btn"
              onClick={() => {
                openOAuthPopup("/api/mail/connect?provider=gmail", (_provider, status) => {
                  if (status === "ok") refreshMailStatus();
                });
              }}
            >
              Connect Gmail →
            </button>
            <button
              type="button"
              className="setup-btn"
              onClick={() => {
                openOAuthPopup("/api/mail/connect?provider=outlook", (_provider, status) => {
                  if (status === "ok") refreshMailStatus();
                });
              }}
              style={{ background: "rgba(0,120,212,0.12)", borderColor: "rgba(0,120,212,0.3)", color: "#60b0ff" }}
            >
              Connect Outlook →
            </button>
          </div>
        </div>
      </>
    );
  }

  if (!statusLoaded) {
    return (
      <>
        <div className="divider" />
        <div style={{ padding: 32, textAlign: "center", color: "var(--ink-dim)", fontSize: "13px" }}>
          Loading…
        </div>
      </>
    );
  }

  return (
    <>
      <div className="divider" />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 16px",
            borderBottom: "1px solid var(--line)",
            flexShrink: 0,
            flexWrap: "wrap",
            rowGap: 6,
          }}
        >
          {/* Account filter tabs */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, flexWrap: "wrap" }}>
            {/* "Inbox" label + unread badge */}
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--ink)", marginRight: 4 }}>
              Inbox
              {unreadCount > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: "11px",
                    fontWeight: 700,
                    background: "var(--accent)",
                    color: "#000",
                    borderRadius: 10,
                    padding: "1px 6px",
                  }}
                >
                  {unreadCount}
                </span>
              )}
            </span>

            {/* All tab */}
            <button
              type="button"
              onClick={() => setAccountFilter("all")}
              style={{
                fontSize: "11px",
                fontWeight: accountFilter === "all" ? 600 : 400,
                padding: "3px 8px",
                borderRadius: 4,
                background: accountFilter === "all"
                  ? "var(--glass)"
                  : "transparent",
                border: "1px solid",
                borderColor: accountFilter === "all"
                  ? "var(--line-strong)"
                  : "var(--line)",
                color: "var(--ink)",
                cursor: "pointer",
              }}
            >
              All
            </button>

            {/* Per-account tabs */}
            {accounts.map((acct) => {
              const isActive = accountFilter === acct.mailEmail;
              return (
                <span
                  key={`${acct.provider}:${acct.mailEmail}`}
                  style={{ display: "flex", alignItems: "center", gap: 3 }}
                >
                  <button
                    type="button"
                    onClick={() => setAccountFilter(isActive ? "all" : acct.mailEmail)}
                    title={acct.mailEmail}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: "11px",
                      fontWeight: isActive ? 600 : 400,
                      padding: "3px 8px",
                      borderRadius: 4,
                      background: isActive
                        ? acct.provider === "gmail"
                          ? "rgba(234,67,53,0.15)"
                          : "rgba(0,120,212,0.15)"
                        : "transparent",
                      border: "1px solid",
                      borderColor: isActive
                        ? acct.provider === "gmail"
                          ? "rgba(234,67,53,0.3)"
                          : "rgba(0,120,212,0.3)"
                        : "var(--line)",
                      color: isActive
                        ? acct.provider === "gmail" ? "#ea4335" : "#0078d4"
                        : "var(--ink-dim)",
                      cursor: "pointer",
                    }}
                  >
                    <ProviderDot provider={acct.provider} />
                    {abbreviateEmail(acct.mailEmail)}
                  </button>
                  {/* Disconnect × */}
                  <button
                    type="button"
                    onClick={() => disconnect(acct)}
                    title={`Disconnect ${acct.mailEmail}`}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--ink-faint)",
                      cursor: "pointer",
                      fontSize: "12px",
                      padding: "0 2px",
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>

          {/* Sort toggle */}
          <div
            style={{
              display: "flex",
              borderRadius: 4,
              border: "1px solid var(--line)",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            {(["date", "priority"] as SortMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSortMode(mode)}
                style={{
                  fontSize: "11px",
                  fontWeight: sortMode === mode ? 600 : 400,
                  padding: "3px 8px",
                  background: sortMode === mode
                    ? "var(--glass)"
                    : "transparent",
                  border: "none",
                  color: sortMode === mode ? "var(--ink)" : "var(--ink-dim)",
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Add account button */}
          <div ref={addBtnRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setShowAddPicker((v) => !v)}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: 4,
                background: "transparent",
                border: "1px solid var(--line)",
                color: "var(--ink-dim)",
                cursor: "pointer",
              }}
            >
              + Add
            </button>
            {showAddPicker && <AddAccountPicker onClose={() => setShowAddPicker(false)} onConnected={refreshMailStatus} />}
          </div>

          {/* Compose */}
          {accounts.length > 0 && (
            <button
              type="button"
              onClick={() => setComposeDraft({})}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: 4,
                background: "var(--accent)",
                border: "none",
                color: "#000",
                fontWeight: 600,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              ✏ Compose
            </button>
          )}

          {/* Refresh */}
          <button
            type="button"
            onClick={() => fetchInbox()}
            disabled={loading}
            style={{
              background: "none",
              border: "none",
              color: "var(--ink-dim)",
              cursor: loading ? "default" : "pointer",
              fontSize: "14px",
              padding: "2px 4px",
              opacity: loading ? 0.4 : 1,
              flexShrink: 0,
            }}
            title="Refresh"
          >
            ↻
          </button>
        </div>

        {/* Message list */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {loading && visibleMessages.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-dim)", fontSize: "13px" }}>
              Loading…
            </div>
          ) : visibleMessages.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-dim)", fontSize: "13px" }}>
              Inbox is empty.
            </div>
          ) : (
            visibleMessages.map((msg) => (
              <MessageRow
                key={`${msg.provider}:${msg.accountEmail}:${msg.id}`}
                msg={msg}
                selected={selected?.id === msg.id}
                onClick={() => openMessage(msg)}
              />
            ))
          )}
        </div>

        {/* Message detail overlay */}
        {loadingMsg && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--surface, #0f0f0f)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
              fontSize: "13px",
              color: "var(--ink-dim)",
            }}
          >
            Loading message…
          </div>
        )}
        {selected && !loadingMsg && (
          <MessagePanel
            message={selected}
            onClose={() => setSelected(null)}
            onReply={(draft) => { setSelected(null); setComposeDraft(draft); }}
          />
        )}
      </div>
      {composeDraft && (
        <ComposeModal
          draft={composeDraft}
          accounts={accounts}
          onClose={() => setComposeDraft(null)}
          onSent={() => setComposeDraft(null)}
        />
      )}
    </>
  );
}
