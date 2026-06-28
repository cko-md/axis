import { describe, it, expect } from "vitest";
import { isBlockedUrl } from "./ssrf";

describe("isBlockedUrl()", () => {
  it("blocks localhost", () => {
    expect(isBlockedUrl("http://localhost/secret")).toBe(true);
  });

  it("blocks 127.0.0.1", () => {
    expect(isBlockedUrl("http://127.0.0.1/secret")).toBe(true);
  });

  it("blocks ::1", () => {
    expect(isBlockedUrl("http://[::1]/secret")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(isBlockedUrl("http://0.0.0.0/secret")).toBe(true);
  });

  it("blocks 10.x private range", () => {
    expect(isBlockedUrl("http://10.0.0.1/internal")).toBe(true);
    expect(isBlockedUrl("http://10.255.255.255/internal")).toBe(true);
  });

  it("blocks 192.168.x private range", () => {
    expect(isBlockedUrl("http://192.168.1.1/router")).toBe(true);
    expect(isBlockedUrl("http://192.168.0.100/config")).toBe(true);
  });

  it("blocks 172.16–31.x private range", () => {
    expect(isBlockedUrl("http://172.16.0.1/internal")).toBe(true);
    expect(isBlockedUrl("http://172.31.255.255/internal")).toBe(true);
    expect(isBlockedUrl("http://172.20.5.5/internal")).toBe(true);
  });

  it("does not block 172.32.x (outside private range)", () => {
    expect(isBlockedUrl("http://172.32.0.1/public")).toBe(false);
  });

  it("does not block 172.15.x (below private range)", () => {
    expect(isBlockedUrl("http://172.15.0.1/public")).toBe(false);
  });

  it("blocks cloud metadata endpoint", () => {
    expect(isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("blocks Google metadata hostname", () => {
    expect(isBlockedUrl("http://metadata.google.internal/computeMetadata/")).toBe(true);
  });

  it("blocks .local domains", () => {
    expect(isBlockedUrl("http://myserver.local/api")).toBe(true);
  });

  it("blocks .internal domains", () => {
    expect(isBlockedUrl("http://myserver.internal/api")).toBe(true);
  });

  it("blocks .localhost domains", () => {
    expect(isBlockedUrl("http://app.localhost/api")).toBe(true);
  });

  it("blocks OAuth hosts", () => {
    expect(isBlockedUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isBlockedUrl("https://login.microsoftonline.com/common/oauth2")).toBe(true);
    expect(isBlockedUrl("https://login.live.com/oauth20_authorize.srf")).toBe(true);
    expect(isBlockedUrl("https://accounts.spotify.com/authorize")).toBe(true);
    expect(isBlockedUrl("https://appleid.apple.com/auth/authorize")).toBe(true);
    expect(isBlockedUrl("https://www.strava.com/oauth/mobile")).toBe(true);
    expect(isBlockedUrl("https://github.com/login/oauth/authorize")).toBe(true);
  });

  it("blocks subdomains of OAuth hosts", () => {
    expect(isBlockedUrl("https://sub.accounts.google.com/test")).toBe(true);
    expect(isBlockedUrl("https://something.login.microsoftonline.com/test")).toBe(true);
  });

  it("blocks non-http(s) schemes", () => {
    expect(isBlockedUrl("ftp://example.com/file")).toBe(true);
    expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
    expect(isBlockedUrl("javascript:alert(1)")).toBe(true);
    expect(isBlockedUrl("data:text/html,<h1>hi</h1>")).toBe(true);
  });

  it("allows normal public https URLs", () => {
    expect(isBlockedUrl("https://example.com/api/data")).toBe(false);
    expect(isBlockedUrl("https://api.example.com/v1/resource")).toBe(false);
  });

  it("allows normal public http URLs", () => {
    expect(isBlockedUrl("http://example.com/api/data")).toBe(false);
  });

  it("blocks invalid URLs", () => {
    expect(isBlockedUrl("not-a-url")).toBe(true);
    expect(isBlockedUrl("")).toBe(true);
    expect(isBlockedUrl("  ")).toBe(true);
  });
});
