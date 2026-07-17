import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nextConfig = readFileSync("next.config.ts", "utf8");
const rootLayout = readFileSync("src/app/layout.tsx", "utf8");
const profileSection = readFileSync("src/components/nav/ProfileSection.tsx", "utf8");
const sidebar = readFileSync("src/components/nav/Sidebar.tsx", "utf8");

describe("platform shell production headers", () => {
  it("allows declared Fontshare resources through the matching CSP directives", () => {
    expect(nextConfig).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
    );
    expect(nextConfig).toContain(
      "font-src 'self' https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com data:",
    );
  });

  it("does not upgrade local HTTP requests or load Vercel telemetry off-platform", () => {
    expect(nextConfig).toContain('process.env.VERCEL === "1"');
    expect(nextConfig).toContain(
      'process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://")',
    );
    expect(rootLayout).toContain(
      '{process.env.VERCEL === "1" ? <SpeedInsights /> : null}',
    );
  });

  it("does not prefetch login before the current account is resolved", () => {
    expect(profileSection).toContain(
      'useState<AccountState>("loading")',
    );
    expect(profileSection).toContain(
      '<Link href="/login" prefetch={false}',
    );
  });

  it("does not fan out authenticated middleware checks from persistent sidebar links", () => {
    expect(sidebar).toContain(
      "href={item.href}\n        prefetch={false}",
    );
    expect(sidebar).toContain(
      '<Link href="/listening-vault" prefetch={false}',
    );
  });
});
