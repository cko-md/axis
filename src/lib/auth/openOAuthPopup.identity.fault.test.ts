// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOAuthPopup } from "./openOAuthPopup";

function message(data: Record<string, unknown>, origin: string, source: MessageEventSource | null) {
  return new MessageEvent("message", { data, origin, source });
}

describe("OAuth popup completion origin boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignores cross-origin and wrong-window oauth completion messages", () => {
    const popup = { closed: false } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const onDone = vi.fn();

    openOAuthPopup("/oauth", onDone);
    window.dispatchEvent(message({ type: "oauth-done", provider: "composio_gmail", status: "ok" }, "https://evil.test", popup));
    window.dispatchEvent(message({ type: "oauth-done", provider: "composio_gmail", status: "ok" }, window.location.origin, window));

    expect(onDone).not.toHaveBeenCalled();
  });

  it("accepts a same-origin message from the OAuth popup only", () => {
    const popup = { closed: false } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const onDone = vi.fn();

    openOAuthPopup("/oauth", onDone);
    window.dispatchEvent(message(
      { type: "oauth-done", provider: "composio_gmail", status: "ok", attempt: "axis-connection-id" },
      window.location.origin,
      popup,
    ));

    expect(onDone).toHaveBeenCalledWith("composio_gmail", "ok", undefined, "axis-connection-id");
  });
});
