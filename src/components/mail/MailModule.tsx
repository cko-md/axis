"use client";

export function MailModule() {
  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Daily</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Mail</h1>
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
          Link Gmail or an IMAP account (read-only) to triage, summarize, and route mail into
          your Inbox. Credentials are handled server-side — never stored in the browser.
        </div>
        <button type="button" className="setup-btn">Connect Mail →</button>
      </div>
    </>
  );
}
