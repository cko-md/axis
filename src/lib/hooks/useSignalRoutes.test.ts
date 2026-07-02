import { describe, expect, it } from "vitest";
import { findMatchingRoute, routeMatches, type SignalRoute } from "@/lib/hooks/useSignalRoutes";

function route(overrides: Partial<SignalRoute>): SignalRoute {
  return {
    id: "r1",
    user_id: "u1",
    label: "Test route",
    destination: "agenda",
    match_keyword: null,
    match_type: null,
    match_source: null,
    set_priority: "keep",
    auto_route: false,
    enabled: true,
    sort_order: 0,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const signal = {
  title: "GitHub PR #42 review requested",
  body: "Riku left comments",
  signal_type: "awaiting" as const,
  source: "GitHub",
};

describe("routeMatches", () => {
  it("requires at least one matcher", () => {
    expect(routeMatches(route({}), signal)).toBe(false);
  });

  it("never matches disabled routes", () => {
    expect(routeMatches(route({ enabled: false, match_source: "GitHub" }), signal)).toBe(false);
  });

  it("matches keyword case-insensitively across title and body", () => {
    expect(routeMatches(route({ match_keyword: "github pr" }), signal)).toBe(true);
    expect(routeMatches(route({ match_keyword: "riku" }), signal)).toBe(true);
    expect(routeMatches(route({ match_keyword: "absent" }), signal)).toBe(false);
  });

  it("requires ALL configured matchers to match", () => {
    expect(routeMatches(route({ match_keyword: "github", match_type: "awaiting", match_source: "github" }), signal)).toBe(true);
    expect(routeMatches(route({ match_keyword: "github", match_type: "action" }), signal)).toBe(false);
    expect(routeMatches(route({ match_source: "Mail" }), signal)).toBe(false);
  });
});

describe("findMatchingRoute", () => {
  it("returns the lowest sort_order enabled match", () => {
    const routes = [
      route({ id: "later", sort_order: 5, match_source: "GitHub", destination: "notes" }),
      route({ id: "first", sort_order: 1, match_keyword: "PR", destination: "pipeline" }),
      route({ id: "disabled", sort_order: 0, enabled: false, match_keyword: "PR" }),
    ];
    expect(findMatchingRoute(routes, signal)?.id).toBe("first");
  });

  it("returns null when nothing matches", () => {
    expect(findMatchingRoute([route({ match_source: "Mail" })], signal)).toBeNull();
  });
});
