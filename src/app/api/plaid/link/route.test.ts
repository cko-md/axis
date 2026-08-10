import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  admitPlaidMutation: vi.fn(),
  getPlaidCreds: vi.fn(),
  timedProviderFetch: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/observability/providerTiming", () => ({ timedProviderFetch: mocks.timedProviderFetch }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));
vi.mock("../_lib", () => ({
  admitPlaidMutation: mocks.admitPlaidMutation,
  getPlaidCreds: mocks.getPlaidCreds,
  PLAID_API_VERSION: "2020-09-14",
  plaidHost: () => "https://plaid.invalid",
  readBoundedPlaidJson: async (response: Response) => response.json().catch(() => null),
}));

import { POST } from "./route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const request = () => new NextRequest("http://axis.test/api/plaid/link", { method: "POST" });

function admin(existing: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.neq = vi.fn(() => chain);
  chain.limit = vi.fn(async () => ({ data: existing, error: null }));
  return { from: vi.fn(() => chain) };
}

describe("Plaid Link product consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })) },
    });
    mocks.createAdminClient.mockReturnValue(admin());
    mocks.admitPlaidMutation.mockResolvedValue("allowed");
    mocks.getPlaidCreds.mockReturnValue({ clientId: "client", secret: "secret", env: "sandbox" });
    mocks.timedProviderFetch.mockResolvedValue(new Response(JSON.stringify({
      link_token: "link-token",
      expiration: new Date(Date.now() + 60_000).toISOString(),
      request_id: "request-id",
    }), { status: 200 }));
  });

  it("requests transaction access plus investment and liability consent", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    const init = mocks.timedProviderFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      user: { client_user_id: USER_ID },
      products: ["transactions"],
      additional_consented_products: ["investments", "liabilities"],
    });
  });

  it("does not request a second link session while any Item is active", async () => {
    mocks.createAdminClient.mockReturnValue(admin([{ id: "existing" }]));

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(mocks.timedProviderFetch).not.toHaveBeenCalled();
  });
});
