import { describe, expect, it } from "vitest";
import { classifyAccess, requiresSupabaseAuth } from "./accessPolicy";

describe("access policy", () => {
  it("classifies only the exact documented exceptions", () => {
    expect(classifyAccess("/")).toBe("static-public-page");
    expect(classifyAccess("/terms")).toBe("static-public-page");
    expect(classifyAccess("/terms/")).toBe("static-public-page");
    expect(classifyAccess("/login")).toBe("public-page");
    expect(classifyAccess("/login/")).toBe("public-page");
    expect(classifyAccess("/api/auth/forgot-password")).toBe("keyless-public");
    expect(classifyAccess("/api/plaid/webhook")).toBe("service-auth");
    expect(classifyAccess("/api/cron/daily")).toBe("service-auth");
    expect(classifyAccess("/monitoring")).toBe("telemetry-ingest");
    expect(classifyAccess("/monitoring/")).toBe("telemetry-ingest");
    expect(classifyAccess("/api/auth/mfa/verify")).toBe("mfa-bootstrap");
  });

  it("defaults lookalikes, dotted paths, and unknown APIs to authenticated", () => {
    [
      "/api/future",
      "/api/auth/forgot-password/extra",
      "/api/cron/daily/extra",
      "/api/auth/profile-evil",
      "/api/mail/message/opaque.jpg",
      "/api/spotify/callback",
      "/fund/position/AAPL.png",
      "/terms-and-conditions",
      "/login/extra",
      "/monitoring/extra",
    ].forEach((pathname) => expect(classifyAccess(pathname)).toBe("authenticated"));
  });

  it("only skips Supabase auth for static pages and independently authenticated services", () => {
    expect(requiresSupabaseAuth("static-public-page")).toBe(false);
    expect(requiresSupabaseAuth("service-auth")).toBe(false);
    expect(requiresSupabaseAuth("telemetry-ingest")).toBe(false);
    expect(requiresSupabaseAuth("public-page")).toBe(true);
    expect(requiresSupabaseAuth("keyless-public")).toBe(true);
    expect(requiresSupabaseAuth("mfa-bootstrap")).toBe(true);
    expect(requiresSupabaseAuth("authenticated")).toBe(true);
  });
});
