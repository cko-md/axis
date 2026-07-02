"use client";

import { useEffect, useMemo, useState } from "react";
import type { MailAttachment, MailMessageFull } from "@/lib/mail/gmail";
import type { MailProvider } from "@/lib/mail/tokens";
import type { ProviderCapabilities } from "@/lib/integrations/registry";
import {
  attachmentKind,
  formatAttachmentSize,
  formatMessageTimestamp,
  loadReaderScale,
  nextReaderScale,
  parseSenderParts,
  READER_SCALES,
  replyAddress,
  replySubject,
  sanitizeMailHtml,
  saveReaderScale,
  senderInitials,
  senderTone,
  stripMailHtml,
  type ReaderScale,
} from "@/lib/mail/reader";
import { ProviderBadge } from "./ProviderBadges";
import type { ComposeDraft } from "./ComposeModal";

type MailMessageAction = "mark-read" | "mark-unread" | "archive" | "delete";

const TONE_VAR: Record<ReturnType<typeof senderTone>, string> = {
  gold: "var(--gold)",
  marine: "var(--marine)",
  clay: "var(--clay)",
  up: "var(--up)",
};

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
  const [scale, setScale] = useState<ReaderScale>("comfortable");
  const readAction: MailMessageAction = message.isUnread ? "mark-read" : "mark-unread";
  const readLabel = message.isUnread ? "Mark read" : "Mark unread";
  const unavailableTitle = "Not available for this mailbox connection yet.";
  const attachments = message.attachments ?? [];

  useEffect(() => {
    setScale(loadReaderScale());
  }, []);

  const cycleScale = () => {
    setScale((current) => {
      const next = nextReaderScale(current);
      saveReaderScale(next);
      return next;
    });
  };

  const sanitizedBody = useMemo(
    () => (message.bodyIsHtml ? sanitizeMailHtml(message.body, showExternalContent) : message.body),
    [message.body, message.bodyIsHtml, showExternalContent],
  );
  const plainBody = message.body || message.snippet || "No message body available.";
  const hasHtmlBody = message.bodyIsHtml && sanitizedBody.trim().length > 0;

  const sender = parseSenderParts(message.from);
  const initials = senderInitials(message.from);
  const tone = TONE_VAR[senderTone(message.from)];
  const subject = message.subject?.trim() || "(no subject)";
  const timestamp = formatMessageTimestamp(message.date);
  const scaleConfig = READER_SCALES[scale];

  const summarize = async () => {
    setSummarizing(true);
    try {
      const body = message.bodyIsHtml ? stripMailHtml(message.body) : message.body;
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
    <div className="mail-doc" role="region" aria-label={`Message: ${subject}`}>
      <style>{`
        .mail-doc {
          position: absolute;
          inset: 0;
          background: var(--bg);
          display: flex;
          flex-direction: column;
          z-index: 10;
        }
        .mail-doc-chrome {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--line);
          background: var(--surface);
          flex-shrink: 0;
          flex-wrap: wrap;
          row-gap: 6px;
        }
        .mail-doc-chrome .grow { flex: 1; }
        .mail-doc-btn {
          background: var(--glass);
          border: 1px solid var(--line);
          border-radius: var(--r, 3px);
          color: var(--ink);
          font-size: 12px;
          font-family: var(--sans);
          padding: 5px 10px;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
          white-space: nowrap;
        }
        .mail-doc-btn:hover:not(:disabled) {
          background: var(--glass-2);
          border-color: var(--line-strong);
        }
        .mail-doc-btn:disabled { cursor: default; opacity: 0.55; }
        .mail-doc-btn.ghost { background: none; border-color: transparent; color: var(--ink-dim); padding-left: 0; }
        .mail-doc-btn.ghost:hover:not(:disabled) { background: none; border-color: transparent; color: var(--ink); }
        .mail-doc-btn.primary {
          background: var(--accent);
          border-color: var(--accent);
          color: var(--on-accent);
          font-weight: 600;
        }
        .mail-doc-btn.primary:hover:not(:disabled) {
          background: var(--accent-bright);
          border-color: var(--accent-bright);
        }
        .mail-doc-btn.danger { color: var(--status-error); }
        .mail-doc-btn.active { background: var(--accent-subtle); border-color: var(--accent); }
        .mail-doc-scroll {
          flex: 1;
          overflow: auto;
          padding: 26px 20px 56px;
        }
        .mail-doc-article {
          max-width: 820px;
          margin: 0 auto;
        }
        .mail-doc-title {
          font-family: var(--serif);
          font-size: 26px;
          font-weight: 500;
          line-height: 1.25;
          letter-spacing: 0.01em;
          color: var(--ink);
          margin: 0 0 18px;
          overflow-wrap: anywhere;
        }
        .mail-doc-identity {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding-bottom: 18px;
          margin-bottom: 20px;
          border-bottom: 1px solid var(--line);
        }
        .mail-doc-avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          flex-shrink: 0;
          display: grid;
          place-items: center;
          font-family: var(--sans);
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.04em;
        }
        .mail-doc-idcol { flex: 1; min-width: 0; }
        .mail-doc-sender {
          display: flex;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
        }
        .mail-doc-sender .name { color: var(--ink); font-size: 13.5px; font-weight: 600; }
        .mail-doc-sender .addr {
          color: var(--ink-dim);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 100%;
        }
        .mail-doc-meta {
          color: var(--ink-dim);
          font-size: 12px;
          margin-top: 3px;
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .mail-doc-meta .sep { color: var(--ink-faint); }
        .mail-doc-timestamp {
          color: var(--ink-dim);
          font-size: 12px;
          white-space: nowrap;
          flex-shrink: 0;
          font-variant-numeric: tabular-nums;
        }
        .mail-doc-attachments {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 8px;
          margin-bottom: 20px;
        }
        .mail-doc-attachment {
          border: 1px solid var(--line);
          border-radius: var(--rl, 7px);
          background: var(--glass);
          padding: 10px;
          min-width: 0;
        }
        .mail-doc-page {
          border: 1px solid var(--line);
          border-radius: var(--rl, 7px);
          overflow: hidden;
        }
        .mail-doc-page.paper {
          background: #fbfaf7;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 12px 34px rgba(0, 0, 0, 0.22);
        }
        .mail-doc-page.plain {
          background: var(--surface-2);
        }
        .mail-message-body {
          overflow-wrap: anywhere;
          word-break: normal;
          color: #1c1a16;
          line-height: 1.6;
          padding: clamp(18px, 4vw, 40px);
        }
        .mail-message-body a { color: #1d4ed8; text-decoration: underline; }
        .mail-message-body img { max-width: 100%; height: auto; border-radius: 6px; }
        .mail-message-body table { max-width: 100%; border-collapse: collapse; }
        .mail-message-body blockquote {
          border-left: 3px solid #d5cfc2;
          margin-left: 0;
          padding-left: 12px;
          color: #5c574d;
        }
        .mail-message-body pre { white-space: pre-wrap; overflow-x: auto; }
        .mail-doc-plainbody {
          font-family: var(--sans);
          color: var(--ink);
          line-height: 1.75;
          white-space: pre-wrap;
          margin: 0;
          padding: clamp(18px, 4vw, 40px);
          overflow-wrap: anywhere;
        }
        .mail-external-note {
          border: 1px dashed #d5cfc2;
          border-radius: 8px;
          color: #5c574d;
          font-size: 12px;
          margin: 0 0 14px;
          padding: 10px 12px;
        }
        .mail-doc-summary {
          padding: 8px 16px;
          background: var(--accent-subtle);
          border-bottom: 1px solid var(--line);
          font-size: 12px;
          color: var(--ink);
          flex-shrink: 0;
        }
      `}</style>

      {/* Chrome: navigation + reading controls + actions */}
      <div className="mail-doc-chrome">
        <button type="button" onClick={onClose} className="mail-doc-btn ghost">
          ← Back
        </button>
        <span className="grow" />
        <button
          type="button"
          onClick={cycleScale}
          className="mail-doc-btn"
          title={`Text size: ${scaleConfig.label.toLowerCase()} — click to change`}
          aria-label={`Text size: ${scaleConfig.label}. Activate to cycle.`}
        >
          Aa · {scaleConfig.label.split(" ")[0]}
        </button>
        {message.bodyIsHtml && (
          <button
            type="button"
            onClick={() => setShowExternalContent((value) => !value)}
            className={`mail-doc-btn${showExternalContent ? " active" : ""}`}
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
            className="mail-doc-btn"
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
              className="mail-doc-btn"
            >
              {busyAction === readAction ? "Saving..." : readLabel}
            </button>
            <button
              type="button"
              onClick={() => onAction("archive")}
              disabled={!capabilities?.archive || !!busyAction}
              title={capabilities?.archive ? "Archive" : unavailableTitle}
              className="mail-doc-btn"
            >
              {busyAction === "archive" ? "Archiving..." : "Archive"}
            </button>
            <button
              type="button"
              onClick={() => onAction("delete")}
              disabled={!capabilities?.delete || !!busyAction}
              title={capabilities?.delete ? "Move to trash" : unavailableTitle}
              className="mail-doc-btn danger"
            >
              {busyAction === "delete" ? "Deleting..." : "Delete"}
            </button>
          </>
        )}
        <button type="button" onClick={summarize} disabled={summarizing} className="mail-doc-btn">
          {summarizing ? "Triaging…" : "AI Triage"}
        </button>
        {onReply && (
          <button
            type="button"
            className="mail-doc-btn primary"
            onClick={() => {
              const quotedBody = `\n\n---\nOn ${new Date(message.date).toLocaleString()}, ${message.from} wrote:\n${(message.bodyIsHtml ? stripMailHtml(message.body) : message.body).slice(0, 1000)}`;
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
          >
            ↩ Reply
          </button>
        )}
      </div>

      {/* AI summary banner */}
      {summary && <div className="mail-doc-summary">{summary}</div>}

      {/* Document */}
      <div className="mail-doc-scroll">
        <article className="mail-doc-article">
          <h1 className="mail-doc-title">{subject}</h1>

          <header className="mail-doc-identity">
            <span
              className="mail-doc-avatar"
              aria-hidden="true"
              style={{
                background: `color-mix(in srgb, ${tone} 18%, var(--surface-2))`,
                border: `1px solid color-mix(in srgb, ${tone} 45%, transparent)`,
                color: tone,
              }}
            >
              {initials}
            </span>
            <div className="mail-doc-idcol">
              <div className="mail-doc-sender">
                <span className="name">{sender.name}</span>
                {sender.email && sender.email !== sender.name && (
                  <span className="addr">&lt;{sender.email}&gt;</span>
                )}
              </div>
              <div className="mail-doc-meta">
                <span>To {message.accountEmail}</span>
              </div>
            </div>
            <time className="mail-doc-timestamp" dateTime={message.date}>
              {timestamp}
            </time>
          </header>

          {attachments.length > 0 && (
            <div className="mail-doc-attachments">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="mail-doc-attachment">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span
                      style={{
                        border: "1px solid var(--line)",
                        borderRadius: 5,
                        color: "var(--ink)",
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "3px 5px",
                        flexShrink: 0,
                      }}
                    >
                      {attachmentKind(attachment.mimeType)}
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
                    {attachment.mimeType} · {formatAttachmentSize(attachment.sizeBytes)}
                  </div>
                  {onRouteAttachmentToLibrary && (
                    <button
                      type="button"
                      onClick={() => onRouteAttachmentToLibrary(attachment)}
                      className="mail-doc-btn"
                      style={{ marginTop: 8, fontSize: 11, padding: "4px 8px", background: "transparent" }}
                      title={
                        capabilities?.attachmentDownload
                          ? "Download this attachment and save it to Library."
                          : "Direct attachment download is not available for this connection yet; create a Dispatch signal for Library routing."
                      }
                    >
                      {capabilities?.attachmentDownload ? "Save to Library" : "Route via Dispatch"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {hasHtmlBody ? (
            <section className="mail-doc-page paper">
              <div className="mail-message-body" style={{ fontSize: scaleConfig.htmlPx }}>
                {!showExternalContent && (
                  <div className="mail-external-note">
                    External images and embedded media are hidden until you choose Show images.
                  </div>
                )}
                <div dangerouslySetInnerHTML={{ __html: sanitizedBody }} />
              </div>
            </section>
          ) : (
            <section className="mail-doc-page plain">
              <pre className="mail-doc-plainbody" style={{ fontSize: scaleConfig.plainPx }}>
                {plainBody}
              </pre>
            </section>
          )}
        </article>
      </div>
    </div>
  );
}
