import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  optionalEnv: vi.fn(),
  memoryRateLimit: vi.fn(),
  anthropicCreate: vi.fn(),
  executeTool: vi.fn(),
  captureRouteError: vi.fn(),
  ToolExecutionError: class ToolExecutionError extends Error {
    constructor(public readonly code: "DATA_UNAVAILABLE" | "PROVIDER_UNAVAILABLE" | "INVALID_INPUT") {
      super(code);
      this.name = "ToolExecutionError";
    }
  },
  ToolOperationalError: class ToolOperationalError extends Error {
    constructor(public readonly code: "DATA_QUERY_FAILED" | "PROVIDER_QUERY_FAILED") {
      super(code);
      this.name = "ToolOperationalError";
    }
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: mocks.anthropicCreate };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
}));
vi.mock("@/lib/ratelimit", () => ({
  memoryRateLimit: mocks.memoryRateLimit,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));
vi.mock("@/lib/ai/tools/registry", () => ({
  TOOLS: [{
    name: "get_cash_accounts",
    description: "Cash",
    input_schema: { type: "object", properties: {} },
  }],
  CITATION_TOOL: {
    name: "respond_with_citation",
    description: "Cite",
    input_schema: { type: "object", properties: {} },
  },
  executeTool: mocks.executeTool,
  ToolExecutionError: mocks.ToolExecutionError,
  ToolOperationalError: mocks.ToolOperationalError,
}));

import { POST } from "./route";

type DbResult = { data: unknown; error: unknown };

function readQuery(result: DbResult) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: DbResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function supabaseClient() {
  const persistedMessages: Array<Record<string, unknown>> = [];
  return {
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        })),
      },
      from: vi.fn((table: string) => {
        if (table === "ai_conversations") {
          return {
            insert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: "conversation-1" },
                  error: null,
                })),
              })),
            })),
            update: vi.fn(() => ({
              eq: vi.fn(async () => ({ error: null })),
            })),
          };
        }
        if (table === "ai_messages") {
          return {
            select: vi.fn(() => readQuery({ data: [], error: null })),
            insert: vi.fn((payload: Record<string, unknown>) => {
              persistedMessages.push(payload);
              return {
                error: null,
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: { id: "message-1", created_at: new Date().toISOString() },
                    error: null,
                  })),
                })),
              };
            }),
          };
        }
        if (table === "ai_tool_calls") {
          return { insert: vi.fn(async () => ({ error: null })) };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    },
    persistedMessages,
  };
}

function request(message = "How much cash do I have?") {
  return new NextRequest("http://axis.test/api/fund/advisor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

describe("fund advisor numerical-claim binding faults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.optionalEnv.mockReturnValue("configured-key");
    mocks.memoryRateLimit.mockReturnValue({ success: true });
    mocks.executeTool.mockResolvedValue({
      accounts: [{ balance: "100.00", currency: "USD" }],
    });
  });

  it("does not return an uncited user-financial number from a no-tool response", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    mocks.anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Your available cash is $123.45." }],
    });

    const response = await POST(request());
    const body = await response.json();

    expect(body.text).not.toContain("$123.45");
    expect(db.persistedMessages.find((message) => message.role === "assistant")?.content)
      .not.toContain("$123.45");
  });

  it("returns explicitly unverified educational prose for a preclassified conceptual question", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    mocks.anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "A price-to-earnings ratio compares a share price with earnings per share." }],
    });

    const response = await POST(request("What is a P/E ratio?"));
    const body = await response.json();

    expect(body.text).toContain("price-to-earnings ratio");
    expect(body.response_metadata).toEqual({ conceptual: true, personal: false, verified: false });
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("never lets model output or conversation context author conceptual prose", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    mocks.anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Your portfolio is worth one million dollars." }],
    });

    const body = await (await POST(request("Explain diversification"))).json();

    expect(body.text).toContain("spreads exposure across assets");
    expect(body.text).not.toContain("Your portfolio");
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("serves deterministic conceptual education without an Anthropic key", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    mocks.optionalEnv.mockReturnValue(undefined);

    const response = await POST(request("What is an expense ratio?"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toContain("recurring annual fund operating cost");
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("does not mark spelled-out numerical claims as server-verified", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "get_cash_accounts",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation-1",
          name: "respond_with_citation",
          input: {
            summary: "Your available cash is one hundred dollars.",
            assumptions: "",
          },
        }],
      });

    const response = await POST(request());
    const body = await response.json();

    expect(body.citation).toMatchObject({ numeric_claims_verified: false });
    expect(body.text).not.toBe("Your available cash is one hundred dollars.");
  });

  it("captures an unexpected financial-tool exception before returning the safe tool error", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    const unexpected = new Error("database transport failed");
    mocks.executeTool.mockRejectedValue(unexpected);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-1", name: "get_cash_accounts", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "citation-1", name: "respond_with_citation", input: {} }],
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.captureRouteError).toHaveBeenCalledWith(unexpected, {
      route: "/api/fund/advisor",
      operation: "execute_financial_tool",
      area: "fund",
      status: 500,
    });
  });

  it("keeps an expected typed tool-domain failure out of Sentry", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    mocks.executeTool.mockRejectedValue(new mocks.ToolExecutionError("DATA_UNAVAILABLE"));
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-1", name: "get_cash_accounts", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "citation-1", name: "respond_with_citation", input: {} }],
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it("captures a typed operational tool failure", async () => {
    const db = supabaseClient();
    mocks.createClient.mockResolvedValue(db.client);
    const operational = new mocks.ToolOperationalError("DATA_QUERY_FAILED");
    mocks.executeTool.mockRejectedValue(operational);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-1", name: "get_cash_accounts", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "citation-1", name: "respond_with_citation", input: {} }],
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.captureRouteError).toHaveBeenCalledWith(operational, {
      route: "/api/fund/advisor",
      operation: "execute_financial_tool",
      area: "fund",
      status: 500,
    });
  });
});
