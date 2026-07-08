import { describe, expect, it } from "vitest";
import { ALLOWED_COMPOSIO_TOOLS } from "@/lib/integrations/composio-allowlist";
import { MAIL_COMPOSIO_TOOLS } from "@/lib/integrations/composio-mail-tools";

describe("composio mail tool allowlist parity", () => {
  it("matches the mail adapter tool slug registry", () => {
    expect([...ALLOWED_COMPOSIO_TOOLS.gmail]).toEqual([...MAIL_COMPOSIO_TOOLS.gmail]);
    expect([...ALLOWED_COMPOSIO_TOOLS.outlook]).toEqual([...MAIL_COMPOSIO_TOOLS.outlook]);
  });
});
