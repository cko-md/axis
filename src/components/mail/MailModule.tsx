"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { MailAttachment, MailMessage, MailMessageFull } from "@/lib/mail/gmail";
import { getCapabilities, type ProviderCapabilities } from "@/lib/integrations/registry";
import type { IntegrationTransport } from "@/lib/integrations/types";
import { useToast } from "@/components/ui/Toast";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { ProviderDot, ProviderBadge } from "./ProviderBadges";
import { AddAccountPicker } from "./AddAccountPicker";
import { ComposeModal, type ComposeDraft } from "./ComposeModal";
import { MessagePanel } from "./MessagePanel";
import { compareMailDateDesc, compareMailIdentity, getMailDateTime } from "@/lib/mail/dates";
import { isEditableTarget, mailShortcutForKey, parseSenderParts } from "@/lib/mail/reader";
import { refreshAfterComposioConnect } from "@/lib/integrations/refreshAfterComposioConnect";

interface MailAccount {
  provider: "gmail" | "outlook";
  mailEmail: string;
  via?: "composio";
}

type MailInboxError = {
  provider: "gmail" | "outlook";
  accountEmail: string;
  transport: "direct" | "composio";
  code: string;
  message: string;
};

type MailInboxResponse = {
  messages?: MailMessage[];
  accounts?: MailAccount[];
  partial?: boolean;
  errors?: MailInboxError[];
  fetchedAt?: string;
  error?: string;
};
type MailStatusResponse = {
  accounts?: MailAccount[];
  error?: string;
};

type SortMode = "date" | "priority";
type AccountFilter = "all" | string; // "all" or a specific mailEmail
type MailMessageAction = "mark-read" | "mark-unread" | "archive" | "delete";
type MessageDetailError = {
  message: MailMessage;
  error: string;
  code?: string;
};

// ─── helpers ────────────────────────────────────────────────────────────────

function priorityScore(msg: MailMessage): number {
  const dateTime = getMailDateTime(msg.date);
  const ageHours = dateTime === null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, (Date.now() - dateTime) / 3600000);
  return (msg.isUnread ? 50 : 0) + Math.max(0, 100 - ageHours);
}

function comparePriorityDesc(a: MailMessage, b: MailMessage): number {
  const diff = priorityScore(b) - priorityScore(a);
  if (diff !== 0) return diff;
  const dateDiff = compareMailDateDesc(a, b);
  return dateDiff !== 0 ? dateDiff : compareMailIdentity(a, b);
}

function formatDate(dateStr: string): string {
  const time = getMailDateTime(dateStr);
  if (time === null) return "Unknown";

  const d = new Date(time);
  const now = new Date();
  const diff = Math.max(0, now.getTime() - time);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function sameMessage(a: Pick<MailMessage, "id" | "provider" | "accountEmail">, b: Pick<MailMessage, "id" | "provider" | "accountEmail">): boolean {
  return a.id === b.id && a.provider === b.provider && a.accountEmail === b.accountEmail;
}

function supportsAction(caps: ProviderCapabilities | undefined, action: MailMessageAction): boolean {
  if (!caps) return false;
  switch (action) {
    case "mark-read":
    case "mark-unread":
      return caps.markRead;
    case "archive":
      return caps.archive;
    case "delete":
      return caps.delete;
  }
}

// ─── sub-components ─────────────────────────────────────────────────────────

function InboxSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading inbox" style={{ borderTop: "1px solid var(--line)" }}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          style={{
            display: "grid",
            gridTemplateColumns: "8px 1fr auto",
            gap: "0 10px",
            padding: "12px 16px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <Skeleton width={7} height={7} borderRadius={999} style={{ marginTop: 5 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
            <Skeleton width={index % 2 === 0 ? "44%" : "56%"} height={13} />
            <Skeleton width={index % 3 === 0 ? "72%" : "84%"} height={12} />
            <Skeleton width="92%" height={12} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7 }}>
            <Skeleton width={48} height={11} />
            <Skeleton width={54} height={18} borderRadius={999} />
          </div>
        </div>
      ))}
    </div>
  );
}

function MailStatusSkeleton() {
  return (
    <>
      <div className="divider" />
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <Skeleton width={72} height={18} />
          <Skeleton width={92} height={22} borderRadius={999} />
          <Skeleton width={108} height={22} borderRadius={999} />
        </div>
        <InboxSkeleton rows={5} />
      </div>
    </>
  );
}

function MessageDetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading message"
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <Skeleton width={64} height={22} />
        <span style={{ flex: 1 }} />
        <Skeleton width={76} height={24} borderRadius={3} />
        <Skeleton width={58} height={24} borderRadius={3} />
        <Skeleton width={70} height={24} borderRadius={3} />
      </div>
      <div style={{ flex: 1, overflow: "hidden", padding: "26px 20px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <Skeleton width="68%" height={26} style={{ marginBottom: 20 }} />
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              paddingBottom: 18,
              marginBottom: 20,
              borderBottom: "1px solid var(--line)",
            }}
          >
            <Skeleton width={40} height={40} borderRadius={999} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
              <Skeleton width="34%" height={13} />
              <Skeleton width="26%" height={11} />
            </div>
            <Skeleton width={140} height={11} />
          </div>
          <div
            style={{
              border: "1px solid var(--line)",
              borderRadius: 7,
              background: "var(--surface-2)",
              padding: 28,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <Skeleton width="88%" height={14} />
            <Skeleton width="96%" height={14} />
            <Skeleton width="74%" height={14} />
            <Skeleton width="91%" height={14} />
            <Skeleton width="52%" height={14} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageDetailErrorPanel({
  detail,
  retrying,
  onBack,
  onRetry,
}: {
  detail: MessageDetailError;
  retrying: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <button
          type="button"
          onClick={onBack}
          style={{ background: "none", border: "none", color: "var(--ink-dim)", cursor: "pointer", padding: "4px 0", fontSize: 13 }}
        >
          ← Back
        </button>
        <span style={{ flex: 1 }} />
        <ProviderBadge provider={detail.message.provider} />
      </div>
      <div style={{ padding: 16, borderBottom: "1px solid var(--line)" }}>
        <div style={{ color: "var(--ink)", fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
          {detail.message.subject || "(no subject)"}
        </div>
        <div style={{ color: "var(--ink-dim)", fontSize: 12 }}>
          {parseSenderParts(detail.message.from).name || "Unknown sender"} · {detail.message.accountEmail}
        </div>
      </div>
      <div style={{ padding: 16, maxWidth: 720 }}>
        <StatusCallout
          kind="error"
          title="Message could not be loaded"
          actionSlot={
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="feed-manage"
              style={{ opacity: retrying ? 0.6 : 1 }}
            >
              {retrying ? "Retrying..." : "Retry"}
            </button>
          }
        >
          {detail.error}
          {detail.code ? <span style={{ display: "block", marginTop: 6, color: "var(--ink-faint)" }}>Code: {detail.code}</span> : null}
        </StatusCallout>
      </div>
    </div>
  );
}

function MessageRow({
  msg,
  selected,
  rowIndex,
  onClick,
}: {
  msg: MailMessage;
  selected: boolean;
  rowIndex?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="mail-row"
      data-row-idx={rowIndex}
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
          {parseSenderParts(msg.from).name || "Unknown"}
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
  const [inboxNotice, setInboxNotice] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<MailMessageFull | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [detailError, setDetailError] = useState<MessageDetailError | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("date");
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("all");
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const [busyAction, setBusyAction] = useState<MailMessageAction | null>(null);
  const [creatingSignal, setCreatingSignal] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [cursorActive, setCursorActive] = useState(false);
  const mountedRef = useRef(true);
  const messagesRef = useRef<MailMessage[]>([]);
  const addBtnRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef<MailMessage[]>([]);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
      .then(async (r) => {
        const s = (await r.json().catch(() => ({}))) as MailStatusResponse;
        if (!r.ok) throw new Error(s.error ?? "Mail status could not be refreshed.");
        return s;
      })
      .then((s) => {
        if (mountedRef.current) {
          setAccounts(s.accounts ?? []);
          setStatusLoaded(true);
        }
      })
      .catch((error) => {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : "Mail status could not be refreshed.";
          setAccounts([]);
          setStatusLoaded(true);
          setInboxNotice(message);
          toast(message, "error", "Mail");
        }
      });
  }, [toast]);

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mail/inbox");
      const data = (await res.json().catch(() => ({}))) as MailInboxResponse;
      if (!mountedRef.current) return;
      if (!res.ok) {
        const message = data.error ?? "Inbox refresh failed.";
        setInboxNotice(messagesRef.current.length ? `Showing last loaded inbox — ${message}` : message);
        toast(message, "error", "Mail");
        return;
      }
      setMessages(data.messages ?? []);
      // Refresh accounts list from response
      if (data.accounts) setAccounts(data.accounts);
      setLastFetchedAt(data.fetchedAt ?? new Date().toISOString());
      if (data.partial && data.errors?.length) {
        const label = data.errors.length === 1 ? "1 mailbox" : `${data.errors.length} mailboxes`;
        setInboxNotice(`Inbox partially refreshed — ${label} could not be reached.`);
        toast(`Inbox partially refreshed — ${label} skipped.`, "warn", "Mail");
      } else {
        setInboxNotice(null);
      }
    } catch {
      if (!mountedRef.current) return;
      const message = "Network error refreshing inbox.";
      setInboxNotice(messagesRef.current.length ? `Showing last loaded inbox — ${message}` : message);
      toast(message, "error", "Mail");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [toast]);

  const refreshMailStatus = useCallback(() => {
    return fetch("/api/mail/status")
      .then(async (r) => {
        const s = (await r.json().catch(() => ({}))) as MailStatusResponse;
        if (!r.ok) throw new Error(s.error ?? "Mail status could not be refreshed.");
        return s;
      })
      .then((s) => {
        if (mountedRef.current) {
          setAccounts(s.accounts ?? []);
          setInboxNotice(null);
        }
        return s;
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        const message = error instanceof Error ? error.message : "Mail status could not be refreshed.";
        setInboxNotice(message);
        toast(message, "error", "Mail");
      });
  }, [toast]);

  const refreshMailAfterConnect = useCallback(() => {
    refreshAfterComposioConnect(async () => {
      await refreshMailStatus();
      if (mountedRef.current) await fetchInbox();
    });
  }, [fetchInbox, refreshMailStatus]);

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
        .then(async (r) => {
          const s = (await r.json().catch(() => ({}))) as MailStatusResponse;
          if (!r.ok) throw new Error(s.error ?? "Mail status could not be refreshed.");
          return s;
        })
        .then((s) => {
          if (mountedRef.current) {
            setAccounts(s.accounts ?? []);
            setInboxNotice(null);
          }
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          const message = error instanceof Error ? error.message : "Mail status could not be refreshed.";
          setInboxNotice(message);
          toast(message, "error", "Mail");
        });
    }
  }, [toast]);

  const messageCapabilities = useCallback((msg: Pick<MailMessage, "provider" | "accountEmail">) => {
    const account = accounts.find((acct) => acct.provider === msg.provider && acct.mailEmail === msg.accountEmail);
    const transport: IntegrationTransport = account?.via === "composio" ? "composio" : "direct";
    return getCapabilities("mail", msg.provider, transport);
  }, [accounts]);

  const updateLocalMessage = useCallback((msg: Pick<MailMessage, "id" | "provider" | "accountEmail">, patch: Partial<MailMessage>) => {
    setMessages((prev) => prev.map((item) => (sameMessage(item, msg) ? { ...item, ...patch } : item)));
    setSelected((prev) => (prev && sameMessage(prev, msg) ? { ...prev, ...patch } : prev));
  }, []);

  const removeLocalMessage = useCallback((msg: Pick<MailMessage, "id" | "provider" | "accountEmail">) => {
    setMessages((prev) => prev.filter((item) => !sameMessage(item, msg)));
    setSelected((prev) => (prev && sameMessage(prev, msg) ? null : prev));
    setDetailError((prev) => (prev && sameMessage(prev.message, msg) ? null : prev));
  }, []);

  const runMessageAction = useCallback(async (
    msg: MailMessage,
    action: MailMessageAction,
    opts?: { automatic?: boolean },
  ) => {
    const caps = messageCapabilities(msg);
    if (!supportsAction(caps, action)) {
      if (!opts?.automatic) {
        toast("That action is not available for this mailbox connection yet.", "error", "Mail");
      }
      return false;
    }

    if (action === "delete" && !window.confirm("Move this message to trash?")) {
      return false;
    }

    const targetUnread =
      action === "mark-read" ? false
        : action === "mark-unread" ? true
          : undefined;

    if (targetUnread !== undefined) {
      updateLocalMessage(msg, { isUnread: targetUnread });
    } else {
      removeLocalMessage(msg);
    }

    setBusyAction(action);
    try {
      const res = await fetch(`/api/mail/message/${encodeURIComponent(msg.id)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          provider: msg.provider,
          email: msg.accountEmail,
        }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(typeof detail.error === "string" ? detail.error : "Provider action failed.");
      }

      if (!opts?.automatic) {
        const verb =
          action === "mark-read" ? "Marked read"
            : action === "mark-unread" ? "Marked unread"
              : action === "archive" ? "Archived"
                : "Moved to trash";
        toast(verb, "success", "Mail");
      }
      return true;
    } catch {
      if (targetUnread !== undefined) {
        updateLocalMessage(msg, { isUnread: msg.isUnread });
      } else {
        setMessages((prev) => (prev.some((item) => sameMessage(item, msg)) ? prev : [msg, ...prev]));
        setSelected((prev) => prev ?? ("body" in msg ? msg as MailMessageFull : null));
      }
      toast(
        action === "mark-read"
          ? "Couldn’t mark this message read. The unread indicator was restored."
          : action === "mark-unread"
            ? "Couldn’t mark this message unread. The read state was restored."
            : action === "archive"
              ? "Couldn’t archive this message. It was restored to the inbox."
              : "Couldn’t delete this message. It was restored to the inbox.",
        "error",
        "Mail",
      );
      return false;
    } finally {
      if (mountedRef.current) setBusyAction(null);
    }
  }, [messageCapabilities, removeLocalMessage, toast, updateLocalMessage]);

  const createSignalFromMessage = useCallback(async (msg: MailMessageFull) => {
    setCreatingSignal(true);
    try {
      const res = await fetch(
        `/api/mail/message/${encodeURIComponent(msg.id)}?provider=${msg.provider}&email=${encodeURIComponent(msg.accountEmail)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create-signal" }),
        },
      );
      const data = await res.json().catch(() => ({} as { error?: string; existing?: boolean; saved?: boolean }));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Could not create Dispatch signal.");
      }
      toast(data.existing ? "Dispatch already has a signal for this message." : "Message sent to Dispatch.", "success", "Mail");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create Dispatch signal.", "error", "Mail");
    } finally {
      if (mountedRef.current) setCreatingSignal(false);
    }
  }, [toast]);

  const routeAttachmentToLibrary = useCallback(async (msg: MailMessageFull, attachment: MailAttachment) => {
    setCreatingSignal(true);
    try {
      const res = await fetch(
        `/api/mail/message/${encodeURIComponent(msg.id)}?provider=${msg.provider}&email=${encodeURIComponent(msg.accountEmail)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "route-attachment-library", attachment }),
        },
      );
      const data = await res.json().catch(() => ({} as { error?: string; existing?: boolean }));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Could not route attachment to Library.");
      }
      toast(
        data.saved
          ? "Attachment saved to Library."
          : data.existing
          ? "Library already has a routed signal for this attachment."
          : "Attachment routed to Library.",
        "success",
        "Mail",
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not route attachment to Library.", "error", "Mail");
    } finally {
      if (mountedRef.current) setCreatingSignal(false);
    }
  }, [toast]);

  const openMessage = useCallback(async (msg: MailMessage) => {
    setDetailError(null);
    setSelected(null);
    setLoadingMsg(true);
    try {
      const res = await fetch(
        `/api/mail/message/${encodeURIComponent(msg.id)}?provider=${msg.provider}&email=${encodeURIComponent(msg.accountEmail)}`,
      );
      const data = await res.json().catch(() => ({} as { error?: string; code?: string }));
      if (res.ok && mountedRef.current) {
        const fullMessage = data as MailMessageFull;
        setSelected(fullMessage);
        if (msg.isUnread) {
          void runMessageAction(fullMessage, "mark-read", { automatic: true });
        }
      } else if (mountedRef.current) {
        const error = typeof data.error === "string" ? data.error : "Couldn't open that message.";
        setDetailError({ message: msg, error, code: typeof data.code === "string" ? data.code : undefined });
        toast(error, "error", "Mail");
      }
    } catch {
      if (mountedRef.current) {
        const error = "Network error loading message.";
        setDetailError({ message: msg, error, code: "network" });
        toast(error, "error", "Mail");
      }
    } finally {
      if (mountedRef.current) setLoadingMsg(false);
    }
  }, [runMessageAction, toast]);

  // Keyboard pass: j/k or arrows move the inbox cursor (and step between
  // messages while reading), Enter/o opens, Esc closes, / focuses search.
  // Never fires while typing or while a modal/picker is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || composeDraft || showAddPicker) return;
      const shortcut = mailShortcutForKey(e.key);
      if (!shortcut || e.metaKey || e.ctrlKey || e.altKey) return;
      const list = visibleRef.current;
      const detailOpen = !!selected || !!detailError || loadingMsg;

      if (shortcut === "close") {
        if (detailOpen) {
          e.preventDefault();
          setSelected(null);
          setDetailError(null);
        }
        return;
      }
      if (shortcut === "search") {
        if (!detailOpen) {
          e.preventDefault();
          searchRef.current?.focus();
        }
        return;
      }
      if (!list.length) return;

      if (detailOpen) {
        if (loadingMsg || (shortcut !== "next" && shortcut !== "prev")) return;
        const anchor = selected ?? detailError?.message;
        if (!anchor) return;
        const idx = list.findIndex((m) => sameMessage(m, anchor));
        const nextIdx = (idx === -1 ? 0 : idx) + (shortcut === "next" ? 1 : -1);
        if (nextIdx >= 0 && nextIdx < list.length) {
          e.preventDefault();
          setCursor(nextIdx);
          void openMessage(list[nextIdx]);
        }
        return;
      }

      if (shortcut === "next" || shortcut === "prev") {
        e.preventDefault();
        setCursorActive(true);
        setCursor((current) => {
          const max = list.length - 1;
          const clamped = Math.min(current, max);
          return shortcut === "next" ? Math.min(clamped + 1, max) : Math.max(clamped - 1, 0);
        });
      } else if (shortcut === "open") {
        e.preventDefault();
        const msg = list[Math.min(cursorRef.current, list.length - 1)];
        if (msg) void openMessage(msg);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, detailError, loadingMsg, composeDraft, showAddPicker, openMessage]);

  // Keep the cursor row in view as it moves.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

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
    setSelected((prev) => (prev?.accountEmail === acct.mailEmail ? null : prev));
    setDetailError((prev) => (prev?.message.accountEmail === acct.mailEmail ? null : prev));
    if (accountFilter === acct.mailEmail) setAccountFilter("all");
    toast("Mailbox disconnected.", "success", "Mail");
    refreshMailStatus();
    void fetchInbox();
  };

  // Filter + sort: account → unread → text search → sort.
  const visibleMessages = (() => {
    let list = accountFilter === "all"
      ? messages
      : messages.filter((m) => m.accountEmail === accountFilter);

    if (unreadOnly) list = list.filter((m) => m.isUnread);

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((m) =>
        m.subject?.toLowerCase().includes(q) ||
        m.from?.toLowerCase().includes(q) ||
        m.snippet?.toLowerCase().includes(q),
      );
    }

    list = sortMode === "priority"
      ? [...list].sort(comparePriorityDesc)
      : [...list].sort(compareMailDateDesc);
    return list;
  })();

  const unreadCount = visibleMessages.filter((m) => m.isUnread).length;
  visibleRef.current = visibleMessages;
  const cursorIdx = visibleMessages.length ? Math.min(cursor, visibleMessages.length - 1) : 0;

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
            {showAddPicker && <AddAccountPicker onClose={() => setShowAddPicker(false)} onConnected={refreshMailAfterConnect} />}
          </div>
        </div>
      </>
    );
  }

  if (!statusLoaded) {
    return <MailStatusSkeleton />;
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

          {/* Search */}
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
            placeholder="Search mail… ( / )"
            style={{
              flex: "1 1 140px",
              minWidth: 110,
              maxWidth: 260,
              fontSize: 12,
              padding: "4px 9px",
              borderRadius: 4,
              border: "1px solid var(--line)",
              background: "var(--glass)",
              color: "var(--ink)",
              outline: "none",
            }}
          />

          {/* Unread-only filter */}
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            aria-pressed={unreadOnly}
            style={{
              fontSize: 11,
              fontWeight: unreadOnly ? 600 : 400,
              padding: "4px 9px",
              borderRadius: 4,
              border: `1px solid ${unreadOnly ? "var(--accent)" : "var(--line)"}`,
              background: unreadOnly ? "var(--glass)" : "transparent",
              color: unreadOnly ? "var(--accent)" : "var(--ink-dim)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Unread
          </button>

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
            {showAddPicker && <AddAccountPicker onClose={() => setShowAddPicker(false)} onConnected={refreshMailAfterConnect} />}
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

        {(inboxNotice || (loading && messages.length > 0)) && (
          <div
            style={{
              padding: "7px 16px",
              borderBottom: "1px solid var(--line)",
              fontSize: 11,
              color: inboxNotice ? "var(--clay)" : "var(--ink-faint)",
              background: "var(--glass)",
            }}
          >
            {inboxNotice ?? "Refreshing inbox…"}
            {lastFetchedAt && !loading && (
              <span style={{ color: "var(--ink-faint)" }}>
                {" "}Last updated {new Date(lastFetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
              </span>
            )}
          </div>
        )}

        {/* Message list */}
        <div ref={listRef} style={{ flex: 1, overflow: "auto" }}>
          {loading && visibleMessages.length === 0 ? (
            <InboxSkeleton rows={8} />
          ) : inboxNotice && messages.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--clay)", fontSize: "13px" }}>
              {inboxNotice}
            </div>
          ) : visibleMessages.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-dim)", fontSize: "13px" }}>
              Inbox is empty.
            </div>
          ) : (
            visibleMessages.map((msg, idx) => (
              <MessageRow
                key={`${msg.provider}:${msg.accountEmail}:${msg.id}`}
                msg={msg}
                selected={selected?.id === msg.id || (cursorActive && idx === cursorIdx)}
                rowIndex={idx}
                onClick={() => { setCursor(idx); void openMessage(msg); }}
              />
            ))
          )}
        </div>

        {/* Message detail overlay */}
        {loadingMsg && <MessageDetailSkeleton />}
        {detailError && !loadingMsg && (
          <MessageDetailErrorPanel
            detail={detailError}
            retrying={loadingMsg}
            onBack={() => setDetailError(null)}
            onRetry={() => { void openMessage(detailError.message); }}
          />
        )}
        {selected && !loadingMsg && (
          <MessagePanel
            message={selected}
            capabilities={messageCapabilities(selected)}
            busyAction={busyAction}
            creatingSignal={creatingSignal}
            onClose={() => setSelected(null)}
            onReply={(draft) => {
              const account = accounts.find(
                (a) => a.provider === selected.provider && a.mailEmail === selected.accountEmail,
              );
              setSelected(null);
              setComposeDraft({
                ...draft,
                via: account?.via === "composio" ? "composio" : "direct",
              });
            }}
            onAction={(action) => { void runMessageAction(selected, action); }}
            onCreateSignal={() => { void createSignalFromMessage(selected); }}
            onRouteAttachmentToLibrary={(attachment) => { void routeAttachmentToLibrary(selected, attachment); }}
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
