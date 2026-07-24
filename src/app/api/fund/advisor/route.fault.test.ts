import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  admit: vi.fn(),
  anthropic: vi.fn(),
  createMessage: vi.fn(),
  executeTool: vi.fn(),
  messageInsert: vi.fn(),
  toolCallInsert: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: { financial: { name: "financial", limit: 20, window: "1 m", protected: true } },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class TestAnthropic {
    messages: { create: typeof mocks.createMessage };

    constructor() {
      mocks.anthropic();
      this.messages = { create: mocks.createMessage };
    }
  },
}));
vi.mock("@/lib/ai/tools/registry", () => ({
  TOOLS: [],
  CITATION_TOOL: { name: "respond_with_citation" },
  executeTool: (...args: unknown[]) => mocks.executeTool(...args),
}));

import { POST } from "./route";

function mockAdvisorPersistence(
  priorMessages: Array<{ role: "user" | "assistant"; content: string }> = [],
) {
  mocks.from.mockImplementation((table: string) => {
    if (table === "ai_conversations") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "conversation-1" },
                error: null,
              }),
            }),
          }),
        }),
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    }
    if (table === "ai_messages") {
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              order: () => ({
                limit: async () => ({
                  data: priorMessages,
                  error: null,
                }),
              }),
            }),
          }),
        }),
        insert: (payload: { role: string }) => {
          mocks.messageInsert(payload);
          return payload.role === "assistant"
            ? {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: "message-1",
                      created_at: "2026-07-23T00:00:00.000Z",
                    },
                    error: null,
                  }),
                }),
              }
            : Promise.resolve({ error: null });
        },
      };
    }
    if (table === "ai_tool_calls") {
      return {
        insert: async (payload: unknown) => {
          mocks.toolCallInsert(payload);
          return { error: null };
        },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });
}

function validCitation(
  summary: string,
  dataSources = ["get_holdings"],
  assumptions = "",
) {
  return {
    summary,
    data_sources: dataSources,
    assumptions,
    confidence: "medium",
    requires_review: true,
  };
}

const holdingsOutput = {
  holdings: [{
    symbol: "AXIS",
    name: "Axis",
    shares: 2,
    cost_basis: 20,
    sources: ["manual"],
  }],
};

const holdingsEvidence = {
  source: "get_holdings",
  title: "Holdings",
  facts: [
    "AXIS (Axis): 2 shares, $20.00 cost basis, sources manual.",
  ],
};

function makeHoldingsOutputOfSize(targetBytes: number) {
  const holdings = Array.from({ length: 20 }, (_, index) => ({
    symbol: `S${index}`,
    name: "x",
    shares: index + 1,
    cost_basis: index + 1,
    sources: ["m"],
  }));
  const output = { holdings };
  let remaining = targetBytes - new TextEncoder().encode(
    JSON.stringify(output),
  ).byteLength;
  for (const holding of holdings) {
    for (const key of ["name", "symbol"] as const) {
      const growth = Math.min(240 - holding[key].length, remaining);
      holding[key] += "x".repeat(Math.max(0, growth));
      remaining -= Math.max(0, growth);
    }
    const sourceGrowth = Math.min(240 - holding.sources[0].length, remaining);
    holding.sources[0] += "x".repeat(Math.max(0, sourceGrowth));
    remaining -= Math.max(0, sourceGrowth);
  }
  if (remaining !== 0) throw new Error(`Could not create ${targetBytes}-byte holdings output`);
  return output;
}

function serverCitation(
  dataSources = ["get_holdings"],
  summary = "Holdings\n• AXIS (Axis): 2 shares, $20.00 cost basis, sources manual.",
) {
  return {
    summary,
    data_sources: dataSources,
    assumptions:
      "Figures are deterministic renderings of verified tool results; provider freshness and coverage may vary.",
    confidence: "medium",
    requires_review: true,
  };
}

describe("fund advisor admission and body boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockReset();
    mocks.executeTool.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mocks.executeTool.mockResolvedValue(holdingsOutput);
  });

  it("stops an unavailable admission backend before any conversation/database or model work", async () => {
    mocks.admit.mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    const response = await POST(new NextRequest("https://axis.test/api/fund/advisor", { method: "POST", body: JSON.stringify({ message: "hello" }) }));
    expect(response.status).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.anthropic).not.toHaveBeenCalled();
  });

  it("rejects an oversized chunked body without trusting content-length", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    const request = new NextRequest("https://axis.test/api/fund/advisor", {
      method: "POST", body: JSON.stringify({ message: "x".repeat(17_000) }),
    });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.anthropic).not.toHaveBeenCalled();
  });

  it("rejects a bounded-body message that exceeds the semantic message limit before writes", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    const response = await POST(new NextRequest("https://axis.test/api/fund/advisor", { method: "POST", body: JSON.stringify({ message: "x".repeat(4001) }) }));
    expect(response.status).toBe(413);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("bounds aggregate persisted history before the first model call", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence(
      Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `${index}:${"h".repeat(4_000)}`,
      })),
    );
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "holdings",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation",
          name: "respond_with_citation",
          input: validCitation("bounded answer"),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "hello",
        }),
      },
    ));

    expect(response.status).toBe(200);
    const modelMessages = mocks.createMessage.mock.calls[0][0].messages as
      Array<{ content: string }>;
    const historyBytes = modelMessages
      .slice(0, -1)
      .reduce(
        (total, message) =>
          total + new TextEncoder().encode(message.content).byteLength,
        0,
      );
    expect(historyBytes).toBeLessThanOrEqual(16_384);
    expect(modelMessages.slice(0, -1).every(
      (message) => message.content.length <= 4_000,
    )).toBe(true);
  });

  it.each([
    ["numeric hallucination", "Your balance is $999; invest $500."],
    ["qualitative advice", "You should invest aggressively right now."],
  ])("discards first-round %s prose and forces verified evidence", async (
    _case,
    providerText,
  ) => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{ type: "text", text: providerText }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "holdings",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation",
          name: "respond_with_citation",
          input: validCitation(providerText),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Tell me what to do.",
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toBe(serverCitation().summary);
    expect(JSON.stringify(body)).not.toContain(providerText);
    expect(JSON.stringify(mocks.messageInsert.mock.calls)).not.toContain(
      providerText,
    );
    expect(mocks.createMessage.mock.calls[1][0].tool_choice).toEqual({
      type: "any",
    });
  });

  it("fails contained after repeated no-tool provider responses", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Balance is $999." }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Invest $500." }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Give me advice.",
        }),
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_CONTEXT_LIMIT",
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
    expect(mocks.messageInsert.mock.calls.some(
      ([payload]) => (payload as { role?: string }).role === "assistant",
    )).toBe(false);
  });

  it("does not accept citation-first without prior verified evidence", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation-first",
          name: "respond_with_citation",
          input: validCitation("Balance is $999."),
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "holdings",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation-valid",
          name: "respond_with_citation",
          input: validCitation("Balance is $999."),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Show verified holdings.",
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toBe(serverCitation().summary);
    expect(JSON.stringify(body)).not.toContain("Balance is $999.");
    expect(JSON.stringify(mocks.createMessage.mock.calls[1][0].messages))
      .toContain("CITATION_REQUIRES_COMPLETED_EVIDENCE");
  });

  it("ignores mixed provider prose when the same response also calls a data tool", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Immediately invest $999." },
          {
            type: "tool_use",
            id: "holdings",
            name: "get_holdings",
            input: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation",
          name: "respond_with_citation",
          input: validCitation("Immediately invest $999."),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Show verified holdings.",
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toBe(serverCitation().summary);
    expect(JSON.stringify(body)).not.toContain("Immediately invest $999.");
    expect(JSON.stringify(mocks.messageInsert.mock.calls)).not.toContain(
      "Immediately invest $999.",
    );
  });

  it("fails contained when citation-first responses exhaust the round budget", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage.mockResolvedValue({
      content: [{
        type: "tool_use",
        id: "citation-only",
        name: "respond_with_citation",
        input: validCitation("Balance is $999."),
      }],
    });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Give me advice.",
        }),
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_CONTEXT_LIMIT",
    });
    expect(mocks.createMessage).toHaveBeenCalledTimes(8);
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(mocks.messageInsert.mock.calls.some(
      ([payload]) => (payload as { role?: string }).role === "assistant",
    )).toBe(false);
  });

  it("bounds aggregate tool-result context before another model call", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation-1",
          name: "respond_with_citation",
          input: validCitation(
            "bounded answer",
            ["get_holdings"],
          ),
        }],
      });
    mocks.executeTool.mockResolvedValue(makeHoldingsOutputOfSize(5_000));

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "inspect my data",
        }),
      },
    ));

    expect(response.status).toBe(200);
    const secondModelMessages =
      mocks.createMessage.mock.calls[1][0].messages as Array<{
        content: string | Array<{ content?: string }>;
      }>;
    const toolResultMessage = secondModelMessages.at(-1);
    const serializedToolContext = JSON.stringify(toolResultMessage?.content);
    expect(new TextEncoder().encode(serializedToolContext).byteLength)
      .toBeLessThanOrEqual(16_384);
  });

  it("defers a same-round citation until the evidence tool has completed", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "get_holdings",
            input: {},
          },
          {
            type: "tool_use",
            id: "citation-too-early",
            name: "respond_with_citation",
            input: validCitation("premature"),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation-after-evidence",
          name: "respond_with_citation",
          input: validCitation("grounded answer"),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "inspect my holdings",
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      text: serverCitation().summary,
      citation: serverCitation(),
      evidence: [holdingsEvidence],
      tool_call_count: 1,
    }));
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.createMessage.mock.calls[1][0].messages))
      .toContain("CITATION_REQUIRES_COMPLETED_EVIDENCE");
  });

  it("rejects a provider response with too many total tool blocks", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage.mockResolvedValue({
      content: Array.from({ length: 9 }, (_, index) => ({
        type: "tool_use",
        id: `citation-${index}`,
        name: "respond_with_citation",
        input: { summary: "not grounded" },
      })),
    });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "hello",
        }),
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_TOOL_LIMIT",
    });
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("caps total tool blocks across the entire turn", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage.mockResolvedValue({
      content: Array.from({ length: 4 }, (_, index) => ({
        type: "tool_use",
        id: `citation-${index}`,
        name: "respond_with_citation",
        input: { summary: "not grounded" },
      })),
    });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "hello",
        }),
      },
    ));

    expect(response.status).toBe(503);
    expect(mocks.createMessage).toHaveBeenCalledTimes(4);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("fails contained when a provider returns terminal prose after evidence", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "uncited numeric answer" }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "inspect my holdings",
        }),
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_CONTEXT_LIMIT",
    });
    expect(mocks.executeTool).toHaveBeenCalledOnce();
  });

  it("rechecks the hard context cap after substituting a placeholder", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-1", name: "get_holdings", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-2", name: "get_holdings", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-3", name: "get_holdings", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "tool-4", name: "get_holdings", input: {} }],
      });
    mocks.executeTool
      .mockResolvedValueOnce(makeHoldingsOutputOfSize(6_000))
      .mockResolvedValueOnce(makeHoldingsOutputOfSize(6_000))
      .mockResolvedValueOnce(makeHoldingsOutputOfSize(3_100))
      .mockResolvedValueOnce(holdingsOutput);

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "inspect bounded data",
        }),
      },
    ));

    expect(response.status).toBe(503);
    expect(mocks.createMessage).toHaveBeenCalledTimes(4);
    expect(mocks.executeTool).toHaveBeenCalledTimes(4);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_CONTEXT_LIMIT",
    });
  });

  it.each([
    ["partial", () => ({ summary: "Balance is 42" })],
    ["empty summary", () => validCitation("")],
    ["empty sources", () => validCitation("Balance is 42", [])],
    ["unknown source", () => validCitation("Balance is 42", ["not_executed"])],
    ["oversized source array", () => validCitation(
      "Balance is 42",
      Array.from({ length: 13 }, (_, index) => `read_${index}`),
    )],
    ["oversized summary", () => validCitation("x".repeat(3_001))],
    ["wrong field type", () => ({
      ...validCitation("Balance is 42"),
      requires_review: "yes",
    })],
    ["prototype-shaped", () => Object.assign(
      Object.create({ polluted: true }),
      validCitation("Balance is 42"),
    )],
  ])("does not let a malformed %s citation terminate the grounded turn", async (_case, malformedCitation) => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.executeTool.mockResolvedValue(holdingsOutput);
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "invalid-citation",
          name: "respond_with_citation",
          input: malformedCitation(),
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "valid-citation",
          name: "respond_with_citation",
          input: validCitation("Balance is 42"),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "What is my balance?",
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      text: serverCitation().summary,
      citation: serverCitation(),
      tool_call_count: 1,
    }));
    expect(mocks.createMessage).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(mocks.createMessage.mock.calls[2][0].messages))
      .toContain("INVALID_CITATION");
  });

  it.each([
    ["scientific notation", "Balance is 1e6", ""],
    ["fraction", "Balance is 1/6", ""],
    ["leading decimal", "Balance is .5", ""],
    ["hex notation", "Balance is 0x10", ""],
    ["spelled-out number", "Balance is one million", ""],
    ["fullwidth digits", "Balance is １,０００", ""],
    ["unsupported ordinary number", "Balance is 999", ""],
    ["unsupported assumption", "Balance is available", "Assume 0x10"],
  ])("never persists model-authored %s financial prose", async (_case, claim, assumptions) => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.executeTool.mockResolvedValue(holdingsOutput);
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "get_holdings",
          input: {},
        }],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "provider-citation",
          name: "respond_with_citation",
          input: validCitation(claim, ["get_holdings"], assumptions),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Give me a contained result",
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({
      text: serverCitation().summary,
      citation: serverCitation(),
    }));
    expect(JSON.stringify(body)).not.toContain(claim);
    if (assumptions) expect(JSON.stringify(body)).not.toContain(assumptions);
    const assistantPersistence = mocks.messageInsert.mock.calls.find(
      ([payload]) => (payload as { role?: string }).role === "assistant",
    );
    expect(JSON.stringify(assistantPersistence)).not.toContain(claim);
    if (assumptions) {
      expect(JSON.stringify(assistantPersistence)).not.toContain(assumptions);
    }
  });

  it("fails visibly instead of claiming safe-to-invest without verified recurring coverage", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.executeTool.mockRejectedValue(Object.assign(
      new Error("DATA_UNAVAILABLE"),
      { name: "ToolExecutionError", code: "DATA_UNAVAILABLE" },
    ));
    mocks.createMessage.mockResolvedValueOnce({
      content: [{
        type: "tool_use",
        id: "safe-to-invest",
        name: "compute_safe_to_invest",
        input: { buffer: 100 },
      }],
    });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "How much is safe to invest?",
        }),
      },
    ));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_EVIDENCE_UNAVAILABLE",
    });
    expect(mocks.toolCallInsert).toHaveBeenCalledWith(expect.objectContaining({
      tool_name: "compute_safe_to_invest",
      output: { error: "DATA_UNAVAILABLE" },
    }));
    expect(mocks.messageInsert.mock.calls.some(
      ([payload]) => (payload as { role?: string }).role === "assistant",
    )).toBe(false);
  });

  it("combines every completed tool's validated evidence", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.executeTool
      .mockResolvedValueOnce(holdingsOutput)
      .mockResolvedValueOnce({
        accounts: [{
          connection_id: "connection-1",
          item_id: "item-1",
          provider_account_id: "provider-account-1",
          persistent_account_id: "persistent-account-1",
          name: "Checking",
          mask: "1234",
          type: "depository",
          subtype: "checking",
          balance: 800,
          balance_basis: "available",
          currency: "USD",
          source: "plaid_live",
          retrieved_at: "2026-07-23T12:00:00Z",
        }],
        total_cash: 800,
        currency: "USD",
        source: "plaid_live",
        retrieved_at: "2026-07-23T12:00:00Z",
        coverage: {
          connections_expected: 1,
          connections_succeeded: 1,
          complete: true,
        },
      });
    mocks.createMessage
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "holdings",
            name: "get_holdings",
            input: {},
          },
          {
            type: "tool_use",
            id: "cash",
            name: "get_cash_accounts",
            input: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [{
          type: "tool_use",
          id: "citation",
          name: "respond_with_citation",
          input: validCitation(
            "Ignore this provider prose.",
            ["get_holdings", "get_cash_accounts"],
          ),
        }],
      });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Show my holdings and cash.",
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.text).toContain("AXIS (Axis): 2 shares");
    expect(body.text).toContain("Verified USD total cash: $800.00");
    expect(body.citation.data_sources).toEqual([
      "get_holdings",
      "get_cash_accounts",
    ]);
    expect(body.evidence).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("Ignore this provider prose");
  });

  it.each([
    ["unavailable", "get_market_quote", {
      symbol: "AXIS",
      available: false,
      reason: "QUOTE_UNAVAILABLE",
    }],
    ["empty", "get_holdings", { holdings: [] }],
    ["unsupported", "unknown_data_tool", { ok: true }],
    ["oversized", "get_holdings", { payload: "x".repeat(7_000) }],
  ])("contains a %s tool result without persisting a successful assistant answer", async (
    _case,
    toolName,
    output,
  ) => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.executeTool.mockResolvedValue(output);
    mocks.createMessage.mockResolvedValueOnce({
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: toolName,
        input: {},
      }],
    });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Give me verified evidence.",
        }),
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_EVIDENCE_UNAVAILABLE",
    });
    expect(mocks.messageInsert.mock.calls.some(
      ([payload]) => (payload as { role?: string }).role === "assistant",
    )).toBe(false);
    expect(mocks.createMessage).toHaveBeenCalledOnce();
  });

  it("contains an INVALID_INPUT tool failure without successful evidence", async () => {
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mockAdvisorPersistence();
    mocks.executeTool.mockRejectedValue(Object.assign(
      new Error("INVALID_INPUT"),
      { name: "ToolExecutionError", code: "INVALID_INPUT" },
    ));
    mocks.createMessage.mockResolvedValueOnce({
      content: [{
        type: "tool_use",
        id: "safe-to-invest",
        name: "compute_safe_to_invest",
        input: { buffer: -1 },
      }],
    });

    const response = await POST(new NextRequest(
      "https://axis.test/api/fund/advisor",
      {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          message: "Use a negative buffer.",
        }),
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ADVISOR_EVIDENCE_UNAVAILABLE",
    });
    expect(mocks.toolCallInsert).toHaveBeenCalledWith(expect.objectContaining({
      tool_name: "compute_safe_to_invest",
      output: { error: "INVALID_INPUT" },
    }));
    expect(mocks.messageInsert.mock.calls.some(
      ([payload]) => (payload as { role?: string }).role === "assistant",
    )).toBe(false);
  });
});
