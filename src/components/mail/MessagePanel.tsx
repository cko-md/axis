"use client";

import { useMemo, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import type { MailAttachment, MailMessageFull } from "@/lib/mail/gmail";
import type { MailProvider } from "@/lib/mail/tokens";
import type { ProviderCapabilities } from "@/lib/integrations/registry";
import { ProviderBadge } from "./ProviderBadges";
import type { ComposeDraft } from "./ComposeModal";

type MailMessageAction = "mark-read" | "mark-unread" | "archive" | "delete";

// Email bodies come straight from Gmail/Outlook senders and are fully
// attacker-controlled — sanitize before ever touching innerHTML. Scripts,
// event handlers, iframes, objects, and forms are stripped; safe formatting
// tags (links, tables, images) pass through.
function sanitizeMailHtml(html: string, allowExternalContent: boolean): string {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "link",
      "meta",
      "base",
      ...(allowExternalContent ? [] : ["img", "picture", "source"]),
    ],
    FORBID_ATTR: [
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onfocus",
      "onblur",
      "srcdoc",
      "formaction",
      ...(allowExternalContent ? [] : ["src", "srcset", "background"]),
    ],
    ADD_ATTR: ["target", "rel", "referrerpolicy", "loading", "decoding", "srcset", "sizes"],
    ALLOW_DATA_ATTR: false,
  });
  return sanitized.replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
    const safeAttrs = attrs
      .replace(/\s(?:target|rel)=("[^"]*"|'[^']*'|[^\s>]*)/gi, "")
      .trim();
    return `<a${safeAttrs ? ` ${safeAttrs}` : ""} target="_blank" rel="noopener noreferrer">`;
  });
}

function formatBytes(sizeBytes?: number | null): string {
  if (!sizeBytes || sizeBytes <= 0) return "Unknown size";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentKind(attachment: MailAttachment): string {
  const type = attachment.mimeType.toLowerCase();
  if (type.includes("pdf")) return "PDF";
  if (type.startsWith("image/")) return "Image";
  if (type.includes("spreadsheet") || type.includes("excel")) return "Sheet";
  if (type.includes("presentation") || type.includes("powerpoint")) return "Deck";
  if (type.includes("word") || type.includes("document")) return "Doc";
  return "File";
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

function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function replyAddress(from: string): string {
  const fromMatch = from.match(/<([^>]+)>/);
  return (fromMatch ? fromMatch[1] : from).trim();
}

export function MessagePanel({
  message,
  capabilities,
  busyAction,
  creatingSignal,
  onClose,
  onReply,
  onAction,
  onCreateSignal,
  onRouteAttachmentToLibrary,
}: {
  message: MailMessageFull;
  capabilities?: ProviderCapabilities;
  busyAction?: MailMessageAction | null;
  creatingSignal?: boolean;
  onClose: () => void;
  onReply?: (draft: ComposeDraft) => void;
  onAction?: (action: MailMessageAction) => void;
  onCreateSignal?: () => void;
  onRouteAttachmentToLibrary?: (attachment: MailAttachment) => void;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [showExternalContent, setShowExternalContent] = useState(false);
  const readAction: MailMessageAction = message.isUnread ? "mark-read" : "mark-unread";
  const readLabel = message.isUnread ? "Mark read" : "Mark unread";
  const unavailableTitle = "Not available for this mailbox connection yet.";
  const attachments = message.attachments ?? [];

  const sanitizedBody = useMemo(
    () => (message.bodyIsHtml ? sanitizeMailHtml(message.body, showExternalContent) : message.body),
    [message.body, message.bodyIsHtml, showExternalContent],
  );
  const plainBody = message.body || message.snippet || "No message body available.";
  const hasHtmlBody = message.bodyIsHtml && sanitizedBody.trim().length > 0;

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
        {message.bodyIsHtml && (
          <button
            type="button"
            onClick={() => setShowExternalContent((value) => !value)}
            style={{
              background: showExternalContent ? "var(--accent-subtle)" : "var(--glass)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--ink)",
              fontSize: "12px",
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            {showExternalContent ? "Hide images" : "Show images"}
          </button>
        )}
        <ProviderBadge provider={message.provider} />
        {onCreateSignal && (
          <button
            type="button"
            onClick={onCreateSignal}
            disabled={creatingSignal}
            style={{
              background: "var(--glass)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              color: "var(--ink)",
              fontSize: "12px",
              padding: "5px 10px",
              cursor: creatingSignal ? "default" : "pointer",
              opacity: creatingSignal ? 0.6 : 1,
            }}
          >
            {creatingSignal ? "Routing..." : "Send to Dispatch"}
          </button>
        )}
        {onAction && (
          <>
            <button
              type="button"
              onClick={() => onAction(readAction)}
              disabled={!capabilities?.markRead || !!busyAction}
              title={capabilities?.markRead ? readLabel : unavailableTitle}
              style={{
                background: "var(--glass)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                color: "var(--ink)",
                fontSize: "12px",
                padding: "5px 10px",
                cursor: !capabilities?.markRead || busyAction ? "default" : "pointer",
                opacity: !capabilities?.markRead || busyAction ? 0.55 : 1,
              }}
            >
              {busyAction === readAction ? "Saving..." : readLabel}
            </button>
            <button
              type="button"
              onClick={() => onAction("archive")}
              disabled={!capabilities?.archive || !!busyAction}
              title={capabilities?.archive ? "Archive" : unavailableTitle}
              style={{
                background: "var(--glass)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                color: "var(--ink)",
                fontSize: "12px",
                padding: "5px 10px",
                cursor: !capabilities?.archive || busyAction ? "default" : "pointer",
                opacity: !capabilities?.archive || busyAction ? 0.55 : 1,
              }}
            >
              {busyAction === "archive" ? "Archiving..." : "Archive"}
            </button>
            <button
              type="button"
              onClick={() => onAction("delete")}
              disabled={!capabilities?.delete || !!busyAction}
              title={capabilities?.delete ? "Move to trash" : unavailableTitle}
              style={{
                background: "var(--glass)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                color: "var(--danger, #ef4444)",
                fontSize: "12px",
                padding: "5px 10px",
                cursor: !capabilities?.delete || busyAction ? "default" : "pointer",
                opacity: !capabilities?.delete || busyAction ? 0.55 : 1,
              }}
            >
              {busyAction === "delete" ? "Deleting..." : "Delete"}
            </button>
          </>
        )}
        {onReply && (
          <button
            type="button"
            onClick={() => {
              const quotedBody = `\n\n---\nOn ${new Date(message.date).toLocaleString()}, ${message.from} wrote:\n${(message.bodyIsHtml ? stripHtml(message.body) : message.body).slice(0, 1000)}`;
              onReply({
                to: replyAddress(message.from),
                subject: replySubject(message.subject),
                body: quotedBody,
                provider: message.provider as MailProvider,
                mailEmail: message.accountEmail,
                inReplyTo: message.id,
                references: message.threadId && message.threadId !== message.id ? message.threadId : undefined,
                threadId: message.threadId,
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
        {attachments.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 8,
              marginTop: 12,
            }}
          >
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  background: "var(--glass)",
                  padding: 10,
                  minWidth: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      border: "1px solid var(--line)",
                      borderRadius: 5,
                      color: "var(--ink)",
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "3px 5px",
                    }}
                  >
                    {attachmentKind(attachment)}
                  </span>
                  <span
                    title={attachment.filename}
                    style={{
                      color: "var(--ink)",
                      fontSize: 12,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {attachment.filename}
                  </span>
                </div>
                <div style={{ color: "var(--ink-dim)", fontSize: 11, marginTop: 5 }}>
                  {attachment.mimeType} · {formatBytes(attachment.sizeBytes)}
                </div>
                {onRouteAttachmentToLibrary && (
                  <button
                    type="button"
                    onClick={() => onRouteAttachmentToLibrary(attachment)}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      color: "var(--ink)",
                      cursor: "pointer",
                      fontSize: 11,
                      marginTop: 8,
                      padding: "4px 8px",
                    }}
                  >
                    Route to Library
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        <style>{`
          .mail-message-body {
            overflow-wrap: anywhere;
            word-break: normal;
          }
          .mail-message-body a {
            color: #0b57d0;
            text-decoration: underline;
          }
          .mail-message-body img {
            max-width: 100%;
            height: auto;
            border-radius: 6px;
          }
          .mail-message-body table {
            max-width: 100%;
            border-collapse: collapse;
          }
          .mail-message-body blockquote {
            border-left: 3px solid #d0d7de;
            margin-left: 0;
            padding-left: 12px;
            color: #57606a;
          }
          .mail-message-body pre {
            white-space: pre-wrap;
            overflow-x: auto;
          }
          .mail-external-note {
            border: 1px dashed #d0d7de;
            border-radius: 8px;
            color: #57606a;
            font-size: 12px;
            margin-bottom: 12px;
            padding: 10px 12px;
          }
        `}</style>
        {hasHtmlBody ? (
          <div
            className="mail-message-body"
            style={{
              background: "#fff",
              borderRadius: 8,
              color: "#111827",
              fontSize: "14px",
              lineHeight: 1.55,
              maxWidth: "100%",
              minHeight: "100%",
              overflowX: "auto",
              padding: 16,
            }}
          >
            {!showExternalContent && (
              <div className="mail-external-note">
                External images and embedded media are hidden until you choose Show images.
              </div>
            )}
            <div dangerouslySetInnerHTML={{ __html: sanitizedBody }} />
          </div>
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
            {plainBody}
          </pre>
        )}
      </div>
    </div>
  );
}
