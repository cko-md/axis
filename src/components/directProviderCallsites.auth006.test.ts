import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("AUTH-006 direct provider browser surface", () => {
  it("routes every browser Spotify and Strava request through the subject-bound boundary", () => {
    const files = [
      "src/components/spotify/SpotifyProvider.tsx",
      "src/components/control-room/ControlRoomModule.tsx",
      "src/components/vault/VaultModule.tsx",
      "src/lib/hooks/useStrava.ts",
      "src/lib/hooks/useWidgetData.ts",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/fetch\(\s*[`"']\/api\/(?:spotify|strava)/);
    }
    expect(read("src/components/spotify/SpotifyProvider.tsx")).toContain("subjectBoundFetch");
    expect(read("src/lib/hooks/useStrava.ts")).toContain("subjectBoundFetch");
  });

  it("has no direct browser widget-cache read and binds batch fetches to shell authority", () => {
    const source = read("src/lib/hooks/useWidgetData.ts");
    expect(source).not.toContain('from("widget_cache")');
    expect(source).not.toContain("createClient");
    expect(source).toContain('subjectBoundFetch(authority.subject, "/api/widgets/batch"');
  });

  it("initiates direct OAuth by subject-bound POST and disconnects Strava by POST", () => {
    const popup = read("src/lib/auth/openOAuthPopup.ts");
    const strava = read("src/lib/hooks/useStrava.ts");
    expect(popup).toContain('window.open("about:blank"');
    expect(popup).toContain('method: "POST"');
    expect(strava).toMatch(/"\/api\/strava\?action=disconnect",\s*\n\s*\{ method: "POST"/);
  });

  it("refreshes direct-provider status and surfaces OAuth errors on every authority transition", () => {
    const source = read("src/components/control-room/ControlRoomModule.tsx");
    expect(source).toContain("refreshSpotifyStatus(),");
    expect(source).toContain("refreshStravaStatus(),");
    expect(source).toContain("describeDirectProviderConnectFailure(\"spotify\", reason)");
    expect(source).toContain("describeDirectProviderConnectFailure(\"strava\", reason)");
    expect(source).toMatch(/authorityEpoch,[\s\S]*profile\?\.subject,[\s\S]*refreshSpotifyStatus,[\s\S]*refreshStravaStatus/);
  });

  it("quarantines shell authority on auth, storage, BFCache, focus, and visibility events", () => {
    const source = read("src/components/layout/ShellProfileContext.tsx");
    for (const marker of [
      "onAuthStateChange",
      'addEventListener("storage"',
      'addEventListener("pageshow"',
      'addEventListener("focus"',
      'addEventListener("visibilitychange"',
      "setCommittedProfile(null)",
      "setAuthorityEpoch",
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).not.toContain("auth.getUser()");
  });
});
