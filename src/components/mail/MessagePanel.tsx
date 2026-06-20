"use client";

import { useMemo, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import type { MailMessageFull } from "@/lib/mail/gmail";
import type { MailProvider } from "@/lib/mail/tokens";
import { ProviderBadge } from "./ProviderBadges";
import type { ComposeDraft } from "./ComposeModal";

// Email bodies come straight from Gmail/Outlook senders and are fully
// attacker-controlled — sanitize before ever touching innerHTML. Scripts,
// event handlers, iframes, objects, and forms are stripped; safe formatting
// tags (links, tables, images) pass through.
function sanitizeMailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "link", "meta", "base"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "srcdoc", "formaction"],
    ALLOW_DATA_ATTR: false,
  });
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

export function MessagePanel({
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

  const sanitizedBody = useMemo(
    () => (message.bodyIsHtml ? sanitizeMailHtml(message.body) : message.body),
    [message.body, message.bodyIsHtml],
  );

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
            dangerouslySetInnerHTML={{ __html: sanitizedBody }}
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
