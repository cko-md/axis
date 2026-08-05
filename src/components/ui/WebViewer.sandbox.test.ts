import { describe, expect, it } from "vitest";

import { WEB_VIEWER_SANDBOX } from "./WebViewer";

describe("WebViewer sandbox contract", () => {
  it("permits ordinary page forms without restoring same-origin access", () => {
    expect(WEB_VIEWER_SANDBOX.split(" ")).toContain("allow-forms");
    expect(WEB_VIEWER_SANDBOX.split(" ")).not.toContain("allow-same-origin");
  });
});
