import { describe, expect, it } from "vitest";
import { ALLOWED_COMPOSIO_TOOLS, isAllowedComposioTool } from "@/lib/integrations/composio-allowlist";

describe("Composio execute allowlist", () => {
  it("permits known Gmail read tools", () => {
    expect(isAllowedComposioTool("gmail", "GMAIL_FETCH_EMAILS")).toBe(true);
    expect(isAllowedComposioTool("gmail", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID")).toBe(true);
  });

  it("denies arbitrary tool slugs, including the retired GMAIL_GET_MESSAGE guess", () => {
    expect(isAllowedComposioTool("gmail", "GMAIL_DELETE_ALL_EMAILS")).toBe(false);
    expect(isAllowedComposioTool("gmail", "GMAIL_GET_MESSAGE")).toBe(false);
    expect(isAllowedComposioTool("outlook", "GMAIL_FETCH_EMAILS")).toBe(false);
  });

  it("keeps empty allowlists for toolkits without execute bridge exposure", () => {
    expect(ALLOWED_COMPOSIO_TOOLS.spotify).toEqual([]);
    expect(isAllowedComposioTool("spotify", "SPOTIFY_PLAY")).toBe(false);
  });
});
