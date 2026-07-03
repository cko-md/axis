import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshGoogleOAuth, refreshMicrosoftOAuth } from "./refresh";

describe("OAuth refresh helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves rotated Google refresh tokens when the provider returns one", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 1800,
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshGoogleOAuth("stored-refresh-token")).resolves.toEqual({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 1800,
    });
  });

  it("leaves Microsoft refresh token unchanged when no rotated token is returned", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: "new-access-token",
        expires_in: 3600,
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshMicrosoftOAuth("stored-refresh-token", "Calendars.ReadWrite offline_access")).resolves.toEqual({
      accessToken: "new-access-token",
      expiresIn: 3600,
    });
  });
});
