import { describe, expect, it } from "vitest";
import { findMailAccount } from "./findAccount";
import { projectMailAccount, projectMailMessage, type MailAccountRef } from "./tokens";

const gmail: MailAccountRef = {
  provider: "gmail",
  mailEmail: "Connected account",
  via: "composio",
  connectionId: "axis-gmail-connection",
};

const outlook: MailAccountRef = {
  provider: "outlook",
  mailEmail: "Connected account",
  via: "composio",
  connectionId: "axis-outlook-connection",
};

describe("mail opaque connection identity faults", () => {
  it("rejects same-owner provider substitution instead of selecting by account id first", () => {
    expect(findMailAccount([gmail, outlook], "gmail", "Connected account", "axis-outlook-connection"))
      .toBeUndefined();
  });

  it("does not treat a raw provider account id as an opaque local selector", () => {
    expect(findMailAccount([gmail, outlook], "gmail", "Connected account", "remote-gmail-account"))
      .toBeUndefined();
  });

  it("rejects a missing selector when multiple placeholder mailboxes are ambiguous", () => {
    expect(findMailAccount([gmail, { ...gmail, connectionId: "axis-gmail-connection-2" }], "gmail", "Connected account"))
      .toBeUndefined();
  });

  it("removes remote account IDs from browser-safe account and message projections", () => {
    const account = projectMailAccount(gmail);
    const message = projectMailMessage({
      id: "message-1",
      threadId: "thread-1",
      from: "sender@example.test",
      subject: "subject",
      date: "2026-07-23",
      snippet: "snippet",
      isUnread: true,
      provider: "gmail",
      accountEmail: "Connected account",
    }, gmail);

    expect(account).toEqual({
      provider: "gmail",
      mailEmail: "Connected account",
      via: "composio",
      connectionId: "axis-gmail-connection",
    });
    expect(message).toMatchObject({ connectionId: "axis-gmail-connection" });
    expect(JSON.stringify({ account, message })).not.toContain("connectedAccountId");
  });
});
