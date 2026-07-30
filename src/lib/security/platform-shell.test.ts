import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nextConfig = readFileSync("next.config.ts", "utf8");
const rootLayout = readFileSync("src/app/layout.tsx", "utf8");
const appShell = readFileSync("src/components/layout/AppShell.tsx", "utf8");
const shellProfileContext = readFileSync(
  "src/components/layout/ShellProfileContext.tsx",
  "utf8",
);
const profileSection = readFileSync("src/components/nav/ProfileSection.tsx", "utf8");
const topbar = readFileSync("src/components/nav/Topbar.tsx", "utf8");
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
    expect(shellProfileContext).toContain('state: "loading"');
    expect(profileSection).toContain(
      '<Link href="/login" prefetch={false}',
    );
  });

  it("owns one abortable same-origin identity read above collapsible shell consumers", () => {
    for (const component of [profileSection, topbar]) {
      expect(component).not.toContain("auth.getUser");
    }
    expect(topbar).not.toContain('fetch("/api/auth/profile"');
    expect(profileSection).not.toMatch(
      /fetch\("\/api\/auth\/profile",\s*\{\s*signal/,
    );
    expect(shellProfileContext).toContain('fetch("/api/auth/profile"');
    expect(shellProfileContext).toContain("new AbortController()");
    expect(shellProfileContext).toContain("controller.abort()");
    expect(appShell).toContain("<ShellProfileProvider>");
    expect(appShell).toContain("<Sidebar collapsed={sidebarMode === \"icons\"} />");
  });

  it("does not fan out authenticated middleware checks from persistent sidebar links", () => {
    // Convergence: nav links keep prefetch={false} but use phase9's
    // workspace-scoped href (hrefWithWorkspace), not VECTOR's raw item.href.
    expect(sidebar).toContain(
      "href={href}\n        prefetch={false}",
    );
    expect(sidebar).toContain(
      'href={hrefWithWorkspace("/listening-vault")}\n        prefetch={false}',
    );
  });
});
