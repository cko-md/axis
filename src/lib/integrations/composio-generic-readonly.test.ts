import { describe, expect, it } from "vitest";
import { isAllowedComposioTool } from "./composio-allowlist";

describe("generic Composio execute scope", () => {
  it("allows only reads while preserving the historical adapter registry", () => {
    expect(isAllowedComposioTool("gmail", "GMAIL_SEND_EMAIL")).toBe(true);
    expect(isAllowedComposioTool("gmail", "GMAIL_SEND_EMAIL", "generic_read_only")).toBe(false);
    expect(isAllowedComposioTool("outlook", "OUTLOOK_SEND_EMAIL", "generic_read_only")).toBe(false);
    expect(isAllowedComposioTool("gmail", "GMAIL_FETCH_EMAILS", "generic_read_only")).toBe(true);
  });
});
