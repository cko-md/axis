"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { MailMessage, MailMessageFull } from "@/lib/mail/gmail";
import { useToast } from "@/components/ui/Toast";
import { ProviderDot, ProviderBadge } from "./ProviderBadges";
import { AddAccountPicker } from "./AddAccountPicker";
import { ComposeModal, type ComposeDraft } from "./ComposeModal";
import { MessagePanel } from "./MessagePanel";

interface MailAccount {
  provider: "gmail" | "outlook";
  mailEmail: string;
  via?: "composio";
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

// ─── sub-components ─────────────────────────────────────────────────────────

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
    // accounts.length (not just isConnected) so connecting a 2nd+ account re-fetches the inbox
  }, [isConnected, accounts.length, fetchInbox]);

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
    // Composio-connected accounts disconnect through Composio (toolkit == provider);
    // any remaining legacy direct-OAuth accounts use the token-table disconnect.
    const res = acct.via === "composio"
      ? await fetch(`/api/integrations/composio/disconnect?toolkit=${acct.provider}`, { method: "DELETE" })
      : await fetch(
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
          {/* Same AddAccountPicker the connected-state toolbar's "+ Add" button
              opens (line ~545) — previously this empty state had its own
              hardcoded direct-OAuth-only buttons, so a brand-new user could
              never reach the Composio rows on their first connect. */}
          <div ref={addBtnRef} style={{ position: "relative", display: "inline-block" }}>
            <button
              type="button"
              className="setup-btn"
              onClick={() => setShowAddPicker((v) => !v)}
            >
              Connect mailbox →
            </button>
            {showAddPicker && <AddAccountPicker onClose={() => setShowAddPicker(false)} onConnected={refreshMailStatus} />}
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
                    color: "var(--on-accent)",
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
                color: "var(--on-accent)",
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
