import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  optionalEnv: vi.fn(),
  memoryRateLimit: vi.fn(),
  anthropicCreate: vi.fn(),
  executeTool: vi.fn(),
  captureRouteError: vi.fn(),
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
});
