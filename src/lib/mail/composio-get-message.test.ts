/**
 * Regression tests for getComposioMessage() — verifies:
 *  1. The primary tool slug (GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID) is tried first.
 *  2. Fallback to GMAIL_GET_MESSAGE when the primary slug fails.
 *  3. ComposioError is thrown when all slug+arg combinations fail.
 *  4. Null is returned (not an error) when all calls succeed but normalization
 *     yields nothing (e.g. the provider returned an empty/unrecognisable payload).
 *  5. Various Composio response-wrapping shapes (`.message`, `.data`, `.email`,
 *     `.response`, and root-level) are correctly unwrapped.
 *  6. Full normalisation including a native Gmail payload (base64url body).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>(
    "@/lib/integrations/composio",
  );
  return { ...actual, executeTool: executeToolMock };
});

import { getComposioMessage, GMAIL_FETCH_MESSAGE_SLUG } from "./composio";

const ACCOUNT = "ca_test_123";
const USER = "user_test_456";
const MSG_ID = "msg_abc789";
const EMAIL = "test@gmail.com";

function success(data: unknown) {
  return { successful: true as const, data, error: null };
}

function failure(error = "Provider error") {
  return { successful: false as const, data: null, error };
}

/** Minimal Gmail message record that normalizes successfully. */
function minimalMsg(id = MSG_ID) {
  return { id, snippet: "hello", labelIds: [] as string[] };
}

describe("getComposioMessage() — slug selection", () => {
  beforeEach(() => executeToolMock.mockReset());

  it("enforces GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID as the exported primary slug constant", () => {
    expect(GMAIL_FETCH_MESSAGE_SLUG).toBe("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
  });

  it("calls GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID first", async () => {
    executeToolMock.mockResolvedValueOnce(success(minimalMsg()));

    await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);

    const firstCall = executeToolMock.mock.calls[0] as [{ toolSlug: string }];
    expect(firstCall[0].toolSlug).toBe("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
  });

  it("falls back to GMAIL_GET_MESSAGE when the primary slug fails every arg variant", async () => {
    // Queue 5 failures for all arg variants of the primary slug, then a success
    // for the first arg variant of the secondary slug.
    executeToolMock
      .mockResolvedValueOnce(failure("slug unavailable"))
      .mockResolvedValueOnce(failure("slug unavailable"))
      .mockResolvedValueOnce(failure("slug unavailable"))
      .mockResolvedValueOnce(failure("slug unavailable"))
      .mockResolvedValueOnce(failure("slug unavailable"))
      .mockResolvedValueOnce(success(minimalMsg()));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result).not.toBeNull();

    // All 5 primary-slug failures + 1 secondary-slug success = 6 calls total.
    expect(executeToolMock).toHaveBeenCalledTimes(6);
    const calls = executeToolMock.mock.calls as Array<[{ toolSlug: string }]>;
    // Every call in the first 5 should use the primary slug.
    for (let i = 0; i < 5; i++) {
      expect(calls[i][0].toolSlug).toBe("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
    }
    // The 6th call (index 5) should use the fallback slug.
    expect(calls[5][0].toolSlug).toBe("GMAIL_GET_MESSAGE");
  });

  it("throws ComposioError when all slug+arg combinations return provider errors", async () => {
    executeToolMock.mockResolvedValue(failure("Provider unavailable"));

    await expect(
      getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL),
    ).rejects.toMatchObject({ message: "Provider unavailable", status: 502 });
  });

  it("returns null (not an error) when all attempts succeed but normalization yields nothing", async () => {
    // Successful call but the response contains no recognisable id field.
    executeToolMock.mockResolvedValue(success({ noIdHere: true }));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result).toBeNull();
  });
});

describe("getComposioMessage() — response unwrapping", () => {
  beforeEach(() => executeToolMock.mockReset());

  it("unwraps the .message wrapper", async () => {
    executeToolMock.mockResolvedValueOnce(success({ message: minimalMsg() }));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result?.id).toBe(MSG_ID);
  });

  it("unwraps the .data wrapper", async () => {
    executeToolMock.mockResolvedValueOnce(success({ data: minimalMsg() }));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result?.id).toBe(MSG_ID);
  });

  it("unwraps the .email wrapper", async () => {
    executeToolMock.mockResolvedValueOnce(success({ email: minimalMsg() }));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result?.id).toBe(MSG_ID);
  });

  it("unwraps the .response wrapper", async () => {
    executeToolMock.mockResolvedValueOnce(success({ response: minimalMsg() }));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result?.id).toBe(MSG_ID);
  });

  it("handles a root-level message (no wrapper)", async () => {
    executeToolMock.mockResolvedValueOnce(success(minimalMsg()));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result?.id).toBe(MSG_ID);
  });

  it("threads connectedAccountId through to the normalised message", async () => {
    executeToolMock.mockResolvedValueOnce(success(minimalMsg()));

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result?.connectedAccountId).toBe(ACCOUNT);
  });
});

describe("getComposioMessage() — full payload normalisation", () => {
  beforeEach(() => executeToolMock.mockReset());

  it("decodes a native Gmail multipart payload and returns the HTML body", async () => {
    const html = "<p>Hello from <strong>Gmail</strong></p>";
    const bodyData = Buffer.from(html)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    executeToolMock.mockResolvedValueOnce(
      success({
        id: MSG_ID,
        threadId: "thread-xyz",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "Subject", value: "Rich email" },
            { name: "Date", value: "Thu, 1 Jan 2026 12:00:00 +0000" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: Buffer.from("plain").toString("base64") } },
            { mimeType: "text/html", body: { data: bodyData } },
          ],
        },
        snippet: "Hello from Gmail",
        labelIds: ["INBOX", "UNREAD"],
      }),
    );

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result).not.toBeNull();
    expect(result!.body).toBe(html);
    expect(result!.bodyIsHtml).toBe(true);
    expect(result!.isUnread).toBe(true);
    expect(result!.from).toBe("Alice <alice@example.com>");
    expect(result!.subject).toBe("Rich email");
  });

  it("falls back to Composio flattened body fields when no payload", async () => {
    executeToolMock.mockResolvedValueOnce(
      success({
        id: MSG_ID,
        subject: "Flat body",
        messageHtml: "<p>Composio flat HTML</p>",
        labelIds: [],
      }),
    );

    const result = await getComposioMessage("gmail", ACCOUNT, USER, MSG_ID, EMAIL);
    expect(result!.body).toBe("<p>Composio flat HTML</p>");
    expect(result!.bodyIsHtml).toBe(true);
  });
});
