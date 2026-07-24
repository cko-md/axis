import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  projectMailAccount,
  projectMailMessage,
  publicMailError,
  type MailAccountRef,
} from "./tokens";

const account: MailAccountRef = {
  provider: "gmail",
  mailEmail: "owner@example.test",
  via: "composio",
  connectionId: "axis-connection-42",
};

describe("mail browser response privacy", () => {
  it("uses an explicit public projection rather than a hidden enumerable-property trick", () => {
    const projectedAccount = projectMailAccount(account);
    const projectedMessage = projectMailMessage({
      id: "message-42",
      threadId: "thread-42",
      from: "sender@example.test",
      subject: "Private provider response",
      date: "2026-07-23T00:00:00.000Z",
      snippet: "Preview",
      isUnread: true,
      provider: "gmail",
      accountEmail: account.mailEmail,
    }, account);

    expect(projectedAccount).toEqual({
      provider: "gmail",
      mailEmail: "owner@example.test",
      via: "composio",
      connectionId: "axis-connection-42",
    });
    expect(projectedMessage).toMatchObject({ connectionId: "axis-connection-42" });
    expect(Object.keys(projectedAccount)).not.toContain("connectedAccountId");
    expect(Object.keys(projectedMessage)).not.toContain("connectedAccountId");
    expect(JSON.stringify({ projectedAccount, projectedMessage })).not.toContain("connectedAccountId");
  });

  it("replaces a provider-controlled result message before it can reach a response or Error", () => {
    expect(publicMailError({
      code: "provider_error",
      retryable: true,
    })).toEqual({
      code: "provider_error",
      message: "The mailbox could not complete the request. Try again.",
      retryable: true,
    });
  });

  it("keeps each browser-facing mail route on public serializers and normalized result errors", () => {
    const routeRoot = resolve(process.cwd(), "src/app/api/mail");
    const inbox = readFileSync(resolve(routeRoot, "inbox/route.ts"), "utf8");
    const status = readFileSync(resolve(routeRoot, "status/route.ts"), "utf8");
    const sync = readFileSync(resolve(routeRoot, "sync/route.ts"), "utf8");
    const detail = readFileSync(resolve(routeRoot, "message/[id]/route.ts"), "utf8");
    const action = readFileSync(resolve(routeRoot, "message/[id]/action/route.ts"), "utf8");
    const send = readFileSync(resolve(routeRoot, "send/route.ts"), "utf8");

    expect(status).toContain("accounts: accounts.map(projectMailAccount)");
    expect(inbox).toContain("messages: cache.messages.map((message) => projectMailMessage(message))");
    expect(sync).toContain("messages: publicMessages");
    expect(sync).toContain("accounts: allAccounts.map(projectMailAccount)");
    expect(detail).toContain("NextResponse.json(projectMailMessage(result.data, account))");
    for (const source of [sync, detail, action, send]) {
      expect(source).toContain("publicMailError(result.error)");
      expect(source).not.toContain("result.error.message");
    }
  });

  it("keys the server-owned mail cache by its local connection id", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/mail/cache.ts"), "utf8");
    const inbox = readFileSync(resolve(process.cwd(), "src/app/api/mail/inbox/route.ts"), "utf8");
    const sync = readFileSync(resolve(process.cwd(), "src/app/api/mail/sync/route.ts"), "utf8");

    expect(source).toContain('import "server-only"');
    expect(source).toContain("account.connectionId ?? \"\"");
    expect(source).toContain("composio_connection_id: account.connectionId ?? null");
    expect(source).toContain('.eq("composio_connection_id", account.connectionId)');
    expect(source).not.toContain('.eq("account_email", account.mailEmail)');
    expect(source).not.toContain("connected_account_id");
    expect(inbox).toContain("readMailCache(admin, user.id, account)");
    expect(sync).toContain("createAdminClient()");
    expect(sync).toContain("connectionId");
  });

  it("dispatches reads through fresh local-id verification and blocks Phase 1A mutations", () => {
    const composio = readFileSync(resolve(process.cwd(), "src/lib/mail/composio.ts"), "utf8");
    const gmailAdapter = readFileSync(resolve(process.cwd(), "src/lib/mail/adapters/gmail-composio.ts"), "utf8");
    const outlookAdapter = readFileSync(resolve(process.cwd(), "src/lib/mail/adapters/outlook-composio.ts"), "utf8");
    const registry = readFileSync(resolve(process.cwd(), "src/lib/integrations/registry.ts"), "utf8");

    expect(composio).toContain("executeVerifiedComposioTool");
    expect(composio).not.toContain("executeTool(");
    expect(gmailAdapter).not.toContain("sendComposioMail(");
    expect(gmailAdapter).not.toContain("markComposioGmailReadState(");
    expect(gmailAdapter).toContain("Mail mutations are disabled while provider mutation approval is pending.");
    expect(outlookAdapter).not.toContain("sendComposioMail(");
    expect(outlookAdapter).toContain("Mail send is disabled while provider mutation approval is pending.");
    expect(registry).toContain("send: false");
    expect(registry).toContain("markRead: false");
    expect(readFileSync(resolve(process.cwd(), "src/components/mail/MailModule.tsx"), "utf8"))
      .toContain("...(canCompose ? [{ label: \"Compose\"");
    const send = readFileSync(resolve(process.cwd(), "src/app/api/mail/send/route.ts"), "utf8");
    expect(send).toContain("connectionId?: string");
    expect(send).toContain("&& a.connectionId === connectionId");
    expect(readFileSync(resolve(process.cwd(), "src/components/mail/MailModule.tsx"), "utf8"))
      .toContain("...(canCompose ? [{ label: \"Compose\"");
  });
});
