"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { MailMessage, MailMessageFull } from "@/lib/mail/gmail";

interface MailStatus {
  gmail: boolean;
  gmailEmail: string | null;
  outlook: boolean;
  outlookEmail: string | null;
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
        background: selected ? "var(--surface-hover, rgba(255,255,255,0.06))" : "transparent",
        border: "none",
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-hover, rgba(255,255,255,0.04))";
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
          background: msg.isUnread ? "var(--accent, #60a5fa)" : "transparent",
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
            color: "var(--text-primary, #fff)",
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
            color: msg.isUnread ? "var(--text-primary, #fff)" : "var(--text-secondary, rgba(255,255,255,0.5))",
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
            color: "var(--text-secondary, rgba(255,255,255,0.4))",
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
        <span style={{ fontSize: "11px", color: "var(--text-secondary, rgba(255,255,255,0.4))", whiteSpace: "nowrap" }}>
          {formatDate(msg.date)}
        </span>
        <ProviderBadge provider={msg.provider} />
      </span>
    </button>
  );
}

function MessagePanel({
  message,
  onClose,
}: {
  message: MailMessageFull;
  onClose: () => void;
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
          borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary, rgba(255,255,255,0.5))",
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
        <button
          type="button"
          onClick={summarize}
          disabled={summarizing}
          style={{
            background: "var(--surface-hover, rgba(255,255,255,0.06))",
            border: "1px solid var(--border, rgba(255,255,255,0.1))",
            borderRadius: 6,
            color: "var(--text-primary, #fff)",
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
            background: "var(--accent-subtle, rgba(96,165,250,0.08))",
            borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
            fontSize: "12px",
            color: "var(--text-primary, #fff)",
          }}
        >
          {summary}
        </div>
      )}

      {/* Message meta */}
      <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))", flexShrink: 0 }}>
        <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary, #fff)", marginBottom: 8 }}>
          {message.subject}
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary, rgba(255,255,255,0.5))" }}>
          <span style={{ color: "var(--text-primary, #fff)" }}>From:</span> {message.from}
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary, rgba(255,255,255,0.5))", marginTop: 2 }}>
          {new Date(message.date).toLocaleString()}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        {message.bodyIsHtml ? (
          <div
            style={{ fontSize: "13px", color: "var(--text-primary, #fff)", lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: message.body }}
          />
        ) : (
          <pre
            style={{
              fontFamily: "inherit",
              fontSize: "13px",
              color: "var(--text-primary, #fff)",
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

export function MailModule() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [outlookSkip, setOutlookSkip] = useState(0);
  const [selected, setSelected] = useState<MailMessageFull | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    fetch("/api/mail/status")
      .then((r) => r.json())
      .then((s: MailStatus) => { if (mountedRef.current) setStatus(s); })
      .catch(() => { if (mountedRef.current) setStatus({ gmail: false, gmailEmail: null, outlook: false, outlookEmail: null }); });
  }, []);

  const isConnected = status && (status.gmail || status.outlook);

  const fetchInbox = useCallback(async (pageToken?: string, skip = 0, append = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (pageToken) params.set("pageToken", pageToken);
      if (skip) params.set("skip", String(skip));
      const res = await fetch(`/api/mail/inbox?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      setMessages((prev) => append ? [...prev, ...data.messages] : data.messages);
      setNextPageToken(data.nextPageToken);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isConnected) fetchInbox();
  }, [isConnected, fetchInbox]);

  // Handle ?connected=gmail|outlook toast on return from OAuth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected) {
      window.history.replaceState({}, "", "/mail");
      setStatus((s) =>
        s
          ? connected === "gmail"
            ? { ...s, gmail: true }
            : { ...s, outlook: true }
          : s,
      );
    }
  }, []);

  const openMessage = async (msg: MailMessage) => {
    setLoadingMsg(true);
    try {
      const res = await fetch(`/api/mail/message/${msg.id}?provider=${msg.provider}`);
      if (res.ok && mountedRef.current) setSelected(await res.json());
    } finally {
      if (mountedRef.current) setLoadingMsg(false);
    }
  };

  const loadMore = () => {
    fetchInbox(nextPageToken, outlookSkip + 20, true);
    setOutlookSkip((s) => s + 20);
  };

  const disconnect = async (provider: "gmail" | "outlook") => {
    await fetch(`/api/mail/disconnect?provider=${provider}`, { method: "DELETE" });
    setStatus((s) =>
      s
        ? provider === "gmail"
          ? { ...s, gmail: false, gmailEmail: null }
          : { ...s, outlook: false, outlookEmail: null }
        : s,
    );
    setMessages([]);
  };

  const unreadCount = messages.filter((m) => m.isUnread).length;

  // Setup state
  if (!status || !isConnected) {
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
              onClick={() => { window.location.href = "/api/mail/connect?provider=gmail"; }}
            >
              Connect Gmail →
            </button>
            <button
              type="button"
              className="setup-btn"
              onClick={() => { window.location.href = "/api/mail/connect?provider=outlook"; }}
              style={{ background: "rgba(0,120,212,0.12)", borderColor: "rgba(0,120,212,0.3)", color: "#60b0ff" }}
            >
              Connect Outlook →
            </button>
          </div>
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
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary, #fff)", flex: 1 }}>
            Inbox
            {unreadCount > 0 && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: "11px",
                  fontWeight: 700,
                  background: "var(--accent, #60a5fa)",
                  color: "#000",
                  borderRadius: 10,
                  padding: "1px 6px",
                }}
              >
                {unreadCount}
              </span>
            )}
          </span>

          {/* Connected account chips */}
          {status.gmail && (
            <button
              type="button"
              onClick={() => disconnect("gmail")}
              title="Disconnect Gmail"
              style={{
                fontSize: "11px",
                fontWeight: 500,
                padding: "3px 8px",
                borderRadius: 4,
                background: "rgba(234,67,53,0.1)",
                border: "1px solid rgba(234,67,53,0.2)",
                color: "#ea4335",
                cursor: "pointer",
              }}
            >
              {status.gmailEmail ?? "Gmail"} ×
            </button>
          )}
          {status.outlook && (
            <button
              type="button"
              onClick={() => disconnect("outlook")}
              title="Disconnect Outlook"
              style={{
                fontSize: "11px",
                fontWeight: 500,
                padding: "3px 8px",
                borderRadius: 4,
                background: "rgba(0,120,212,0.1)",
                border: "1px solid rgba(0,120,212,0.2)",
                color: "#0078d4",
                cursor: "pointer",
              }}
            >
              {status.outlookEmail ?? "Outlook"} ×
            </button>
          )}
          {!status.gmail && (
            <button
              type="button"
              onClick={() => { window.location.href = "/api/mail/connect?provider=gmail"; }}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: 4,
                background: "transparent",
                border: "1px solid var(--border, rgba(255,255,255,0.1))",
                color: "var(--text-secondary, rgba(255,255,255,0.5))",
                cursor: "pointer",
              }}
            >
              + Gmail
            </button>
          )}
          {!status.outlook && (
            <button
              type="button"
              onClick={() => { window.location.href = "/api/mail/connect?provider=outlook"; }}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: 4,
                background: "transparent",
                border: "1px solid var(--border, rgba(255,255,255,0.1))",
                color: "var(--text-secondary, rgba(255,255,255,0.5))",
                cursor: "pointer",
              }}
            >
              + Outlook
            </button>
          )}

          <button
            type="button"
            onClick={() => fetchInbox()}
            disabled={loading}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary, rgba(255,255,255,0.4))",
              cursor: loading ? "default" : "pointer",
              fontSize: "14px",
              padding: "2px 4px",
              opacity: loading ? 0.4 : 1,
            }}
            title="Refresh"
          >
            ↻
          </button>
        </div>

        {/* Message list */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {loading && messages.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-secondary, rgba(255,255,255,0.4))", fontSize: "13px" }}>
              Loading…
            </div>
          ) : messages.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-secondary, rgba(255,255,255,0.4))", fontSize: "13px" }}>
              Inbox is empty.
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <MessageRow
                  key={`${msg.provider}:${msg.id}`}
                  msg={msg}
                  selected={selected?.id === msg.id}
                  onClick={() => openMessage(msg)}
                />
              ))}
              {(nextPageToken || outlookSkip > 0) && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loading}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "12px",
                    background: "none",
                    border: "none",
                    borderTop: "1px solid var(--border, rgba(255,255,255,0.06))",
                    color: "var(--text-secondary, rgba(255,255,255,0.4))",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              )}
            </>
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
              color: "var(--text-secondary, rgba(255,255,255,0.4))",
            }}
          >
            Loading message…
          </div>
        )}
        {selected && !loadingMsg && (
          <MessagePanel message={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </>
  );
}
