import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the distinction between "the job could not run" and "the job ran and
 * some sub-tasks failed".
 *
 * Both Make-triggered cron routes previously ended with
 * `{ status: failures === 0 ? 200 : 502 }`. One permanently dead RSS feed out
 * of a dozen therefore turned a successful pre-warm into a gateway error, and
 * Make — which classifies 502 as a retryable ConnectionError — re-ran the
 * scenario on an escalating backoff indefinitely. Observed 2026-07-19: both
 * scenarios had run green daily for three weeks, then retried every few minutes
 * for hours, re-doing work that had already committed.
 *
 * The failures must stay visible (Sentry + response body + `ok: false`); what
 * must not happen is a partial failure masquerading as a transport error.
 */

const ROUTES = [
  "src/app/api/cron/feed-digest/route.ts",
  "src/app/api/cron/intelligence-sweep/route.ts",
];

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Make-triggered cron failure semantics", () => {
  it.each(ROUTES)("%s never reports a partial failure as a gateway error", (relativePath) => {
    const source = read(relativePath);
    expect(
      /status:\s*failures\s*===\s*0\s*\?\s*200\s*:\s*50\d/.test(source),
      `${relativePath} maps a non-zero failure count onto a 5xx status, which makes Make retry indefinitely`,
    ).toBe(false);
  });

  it.each(ROUTES)("%s still reports partial failure truthfully in the body", (relativePath) => {
    const source = read(relativePath);
    // ok:false + an explicit partial flag is the honest channel; dropping these
    // would turn this fix into a silent failure, which is worse than the 502.
    expect(source).toMatch(/ok:\s*failures\s*===\s*0/);
    expect(source).toMatch(/partial:\s*failures\s*>\s*0/);
  });

  it("feed-digest names which feeds failed, not just how many", () => {
    const source = read("src/app/api/cron/feed-digest/route.ts");
    expect(source).toMatch(/failedFeeds/);
  });

  it("feed-digest still fails loudly when it cannot determine the work set", () => {
    // Discovery failing is different in kind: the run genuinely did not happen,
    // so a retry is the correct response and a 5xx is the correct signal.
    const source = read("src/app/api/cron/feed-digest/route.ts");
    expect(source).toMatch(/discoveryFailed[\s\S]{0,400}status:\s*503/);
  });

  it("does not list feeds that are known to be unfetchable server-side", () => {
    // outsideonline.com/feed now 302s to an OAuth authorize endpoint and
    // hespokestyle.com/feed/ returns 403 to non-browser clients. Re-adding
    // either re-creates a permanent non-zero failure count.
    const sources = [
      ...ROUTES,
      "src/components/atelier/AtelierModule.tsx",
      "src/components/vitality/VitalityModule.tsx",
    ];
    for (const relativePath of sources) {
      const source = read(relativePath);
      for (const dead of ['"https://www.outsideonline.com/feed"', '"https://hespokestyle.com/feed/"']) {
        expect(
          source.includes(dead),
          `${relativePath} lists ${dead}, which cannot be fetched server-side`,
        ).toBe(false);
      }
    }
  });
});
