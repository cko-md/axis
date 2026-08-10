import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  aiGenerate: vi.fn(),
  optionalEnv: vi.fn(),
  getPolygonApiKey: vi.fn(),
  fetchNews: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/ai/router", () => ({ aiGenerate: mocks.aiGenerate }));
vi.mock("@/lib/env", () => ({ optionalEnv: mocks.optionalEnv }));
vi.mock("@/lib/massive/client", () => ({
  getPolygonApiKey: mocks.getPolygonApiKey,
  fetchNews: mocks.fetchNews,
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));

import { POST } from "./route";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const NOW = new Date().toISOString();
const request = () => new NextRequest("http://axis.test/api/fund/report", { method: "POST" });

function holdings(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `A${String(index).padStart(2, "0")}`,
    name: `Holding ${index}`,
    shares: "1",
    currency: "USD",
    authority: "provider",
    source: "plaid",
    provider: "plaid",
    provider_record_id: `holding-${index}`,
    connection_id: "connection-1",
    retrieved_at: NOW,
    reconciliation_state: "matched",
    generation_id: GENERATION,
  }));
}

function read(data: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
  chain.then = (resolve: (value: { data: unknown; error: null }) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return chain;
}

function client(
  recordCount: number,
  holdingRows: unknown[] = holdings(11),
  connectionRows: unknown[] = [{
    id: "connection-1",
    provider: "plaid",
    status: "linked",
    authority: "provider_verified",
    verified_at: NOW,
  }],
) {
  const inserts: unknown[] = [];
  const from = vi.fn((table: string) => {
    if (table === "fund_holdings") return read(holdingRows);
    if (table === "fund_watchlist") return read([]);
    if (table === "profiles") return read({ ai_provider: "auto" });
    if (table === "fund_connections") return read(connectionRows);
    if (table === "fund_provider_coverage") return read([{
      connection_id: "connection-1",
      provider: "plaid",
      component: "holdings",
      complete: true,
      record_count: recordCount,
      retrieved_at: NOW,
      availability_status: "available",
      generation_id: GENERATION,
      generation_hash: "a".repeat(64),
    }]);
    if (table === "ai_insights") return {
      insert: vi.fn((payload: unknown) => {
        inserts.push(payload);
        return { select: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: "insight-1" }, error: null })) })) };
      }),
    };
    throw new Error(`Unexpected table ${table}`);
  });
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    from,
    inserts,
  };
}

describe("market report complete-generation verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.optionalEnv.mockReturnValue("anthropic-key");
    mocks.getPolygonApiKey.mockReturnValue(undefined);
    mocks.aiGenerate.mockResolvedValue({ text: "Research draft", model: "test-model" });
  });

  it("verifies all 11 holdings before truncating the model input to 10", async () => {
    const supabase = client(11);
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(request());

    expect(response.status).toBe(200);
    const prompt = JSON.parse(mocks.aiGenerate.mock.calls[0][0].userMessage) as { holdings: unknown[] };
    expect(prompt.holdings).toHaveLength(10);
    expect(supabase.inserts).toHaveLength(1);
  });

  it("does not generate or persist when the complete generation count mismatches", async () => {
    const supabase = client(10);
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "PORTFOLIO_CONTEXT_UNAVAILABLE" });
    expect(mocks.aiGenerate).not.toHaveBeenCalled();
    expect(supabase.inserts).toHaveLength(0);
  });

  it("excludes manual claims without poisoning a complete provider generation", async () => {
    const manual = {
      symbol: "MANUAL",
      name: "Manual claim",
      shares: "1",
      currency: "USD",
      authority: "manual",
      source: "manual",
      provider: null,
      provider_record_id: null,
      connection_id: null,
      retrieved_at: NOW,
      reconciliation_state: null,
      generation_id: null,
    };
    const supabase = client(11, [...holdings(11), manual]);
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(request());

    expect(response.status).toBe(200);
    const prompt = JSON.parse(mocks.aiGenerate.mock.calls[0][0].userMessage) as { holdings: Array<{ symbol: string }> };
    expect(prompt.holdings).toHaveLength(10);
    expect(prompt.holdings.some((holding) => holding.symbol === "MANUAL")).toBe(false);
  });

  it("rejects a 33rd connection instead of validating a truncated coverage universe", async () => {
    const connections = Array.from({ length: 33 }, (_, index) => ({
      id: `connection-${index}`,
      provider: "plaid",
      status: "linked",
      authority: "provider_verified",
      verified_at: NOW,
    }));
    const supabase = client(11, holdings(11), connections);
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "COVERAGE_VERIFICATION_LIMIT_EXCEEDED" });
    expect(mocks.aiGenerate).not.toHaveBeenCalled();
    expect(supabase.inserts).toHaveLength(0);
  });
});
