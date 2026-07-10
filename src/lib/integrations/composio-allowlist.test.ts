import { describe, expect, it } from "vitest";
import { ALLOWED_COMPOSIO_TOOLS, isAllowedComposioTool } from "@/lib/integrations/composio-allowlist";

describe("Composio execute allowlist", () => {
  it("permits known Gmail read tools", () => {
    expect(isAllowedComposioTool("gmail", "GMAIL_FETCH_EMAILS")).toBe(true);
    expect(isAllowedComposioTool("gmail", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")).toBe(true);
    expect(isAllowedComposioTool("gmail", "GMAIL_GET_MESSAGE")).toBe(false);
    expect(isAllowedComposioTool("gmail", "GMAIL_SEND_EMAIL")).toBe(true);
  });

  it("permits known Outlook mail tools", () => {
    expect(isAllowedComposioTool("outlook", "OUTLOOK_LIST_MESSAGES")).toBe(true);
    expect(isAllowedComposioTool("outlook", "OUTLOOK_SEND_EMAIL")).toBe(true);
    expect(isAllowedComposioTool("outlook", "OUTLOOK_GET_MESSAGE")).toBe(true);
  });

  it("denies arbitrary tool slugs", () => {
    expect(isAllowedComposioTool("gmail", "GMAIL_DELETE_ALL_EMAILS")).toBe(false);
    expect(isAllowedComposioTool("outlook", "GMAIL_FETCH_EMAILS")).toBe(false);
  });

  it("keeps empty allowlists for toolkits without execute bridge exposure", () => {
    expect(ALLOWED_COMPOSIO_TOOLS.spotify).toEqual([]);
    expect(isAllowedComposioTool("spotify", "SPOTIFY_PLAY")).toBe(false);
  });
});
