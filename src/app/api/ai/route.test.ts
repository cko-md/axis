import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ALLOWED_AI_MODES } from "@/lib/ai/modes";
import { normalizePayload, parseJsonBody } from "@/lib/ai/request";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  optionalEnv: vi.fn(),
  getGeminiApiKey: vi.fn(),
  redisRateLimit: vi.fn(),
  memoryRateLimit: vi.fn(),
  aiGenerate: vi.fn(),
  aiJSON: vi.fn(),
  captureRouteError: vi.fn(),
  admit: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {},
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mocks.maybeSingle,
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
  getGeminiApiKey: mocks.getGeminiApiKey,
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: mocks.redisRateLimit,
  memoryRateLimit: mocks.memoryRateLimit,
}));
vi.mock("@/lib/ai/router", () => ({
  aiGenerate: mocks.aiGenerate,
  aiJSON: mocks.aiJSON,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    cost: { name: "cost", limit: 20, window: "1 m", protected: true },
  },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));

import { POST } from "./route";

function aiRequest(payload: Record<string, unknown>) {
  return new NextRequest("http://axis.test/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "user_1" } },
    error: null,
  });
  mocks.maybeSingle.mockResolvedValue({
    data: { ai_provider: "anthropic" },
    error: null,
  });
  mocks.optionalEnv.mockReturnValue(undefined);
  mocks.getGeminiApiKey.mockReturnValue(undefined);
  mocks.redisRateLimit.mockResolvedValue({ success: true });
  mocks.memoryRateLimit.mockReturnValue({ success: true });
  mocks.admit.mockResolvedValue({ kind: "allowed" });
});

describe("AI route request parsing", () => {
  it("rejects malformed outer payloads before mode handling", () => {
    expect(normalizePayload(null)).toEqual({
      ok: false,
      error: "Invalid JSON payload",
      status: 400,
    });
  });

  it("defaults missing mode to capture while requiring text to be a string", () => {
    expect(normalizePayload({ text: "capture this" })).toEqual({
      ok: true,
      payload: { mode: "capture", text: "capture this", body: undefined, title: undefined },
    });

    expect(normalizePayload({ mode: "triage", text: 123 })).toEqual({
      ok: false,
      error: "text must be a string",
      status: 422,
    });
  });

  it("rejects unknown AI modes before provider invocation", () => {
    expect(normalizePayload({ mode: "evil-inject", text: "x" })).toEqual({
      ok: false,
      error: "Unknown AI mode: evil-inject",
      status: 400,
    });
  });

  it("rejects non-string nested body and title values", () => {
    expect(normalizePayload({ mode: "route", text: "note", body: { unsafe: true } })).toEqual({
      ok: false,
      error: "body must be a string",
      status: 422,
    });

    expect(normalizePayload({ mode: "route", text: "note", title: ["bad"] })).toEqual({
      ok: false,
      error: "title must be a string",
      status: 422,
    });
  });

  it("caps long private text fields at the route boundary", () => {
    const parsed = normalizePayload({
      mode: "notes-summarize",
      text: "a".repeat(20_050),
      body: "b".repeat(20_050),
      title: "c".repeat(550),
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.text).toHaveLength(20_000);
      expect(parsed.payload.body).toHaveLength(20_000);
      expect(parsed.payload.title).toHaveLength(500);
    }
  });

  it("uses fallback context when nested body JSON is invalid", () => {
    expect(parseJsonBody<{ topics: string[] }>("{not json", { topics: [] })).toEqual({ topics: [] });
    expect(parseJsonBody<{ topics: string[] }>("{\"topics\":[\"dbs\"]}", { topics: [] })).toEqual({ topics: ["dbs"] });
  });
});

describe("POST /api/ai response provenance", () => {
  it("maps authentication backend failure to 503 without quota or model work", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await POST(aiRequest({
      mode: "capture",
      text: "private text",
    }));

    expect(response.status).toBe(503);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.aiGenerate).not.toHaveBeenCalled();
    expect(mocks.aiJSON).not.toHaveBeenCalled();
  });

  it("rejects an oversized outer body before profile or model work", async () => {
    const response = await POST(aiRequest({
      mode: "capture",
      text: "private text",
      padding: "x".repeat(70_000),
    }));

    expect(response.status).toBe(413);
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.aiGenerate).not.toHaveBeenCalled();
    expect(mocks.aiJSON).not.toHaveBeenCalled();
  });

  it("uses canonical admission as the sole quota authority", async () => {
    const response = await POST(aiRequest({
      mode: "capture",
      text: "private text",
    }));

    expect(response.status).toBe(200);
    expect(mocks.admit).toHaveBeenCalledOnce();
    expect(mocks.redisRateLimit).not.toHaveBeenCalled();
    expect(mocks.memoryRateLimit).not.toHaveBeenCalled();
  });

  it("marks every no-key fallback as an explicit not-configured heuristic", async () => {
    for (const mode of ALLOWED_AI_MODES) {
      const response = await POST(aiRequest({
        mode,
        text: "Review the IRB amendment",
        body: "{}",
      }));

      expect(response.status, mode).toBe(200);
      expect((await response.json()).meta, mode).toEqual({
        source: "heuristic",
        degraded: true,
        reason: "not_configured",
      });
    }
    expect(mocks.aiJSON).not.toHaveBeenCalled();
    expect(mocks.aiGenerate).not.toHaveBeenCalled();
  });

  it("sanitizes model-authored cards and marks model success", async () => {
    mocks.optionalEnv.mockReturnValue("configured");
    mocks.aiGenerate.mockResolvedValue({
      model: "claude/haiku",
      text: JSON.stringify([
        {
          title: "  Open\u0000 agenda ",
          body: " Review\n priorities. ",
          actionLabel: " Review ",
          actionPath: "/agenda/",
          secretModelField: "must not cross boundary",
        },
        {
          title: "Unsafe action",
          body: "The content remains, but navigation is removed.",
          actionLabel: "Open",
          actionPath: "javascript:alert(1)",
        },
      ]),
    });

    const response = await POST(aiRequest({
      mode: "deck-insights",
      text: "Agenda context",
      body: "{}",
    }));

    expect(await response.json()).toEqual({
      cards: [
        {
          id: "0",
          title: "Open agenda",
          body: "Review priorities.",
          actionLabel: "Review",
          actionPath: "/agenda",
        },
        {
          id: "1",
          title: "Unsafe action",
          body: "The content remains, but navigation is removed.",
        },
      ],
      meta: {
        source: "model",
        degraded: false,
        reason: null,
      },
    });
  });

  it("uses a provider-error heuristic and records only safe observability metadata", async () => {
    const privateText = "private patient and research details";
    mocks.optionalEnv.mockReturnValue("configured");
    mocks.aiJSON.mockRejectedValue(new Error(`provider failed while processing ${privateText}`));

    const response = await POST(aiRequest({
      mode: "triage",
      text: privateText,
    }));
    const body = await response.json();

    expect(body.meta).toEqual({
      source: "heuristic",
      degraded: true,
      reason: "provider_error",
    });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "AI provider generation failed" }),
      expect.objectContaining({
        route: "ai",
        operation: "generate",
        area: "ai",
        status: 502,
        code: "PROVIDER_ERROR",
        tags: expect.objectContaining({
          mode: "triage",
          degraded: true,
          degradation_reason: "provider_error",
        }),
      }),
    );
    expect(JSON.stringify(mocks.captureRouteError.mock.calls)).not.toContain(privateText);
  });

  it("marks every provider-failure fallback as degraded", async () => {
    mocks.optionalEnv.mockReturnValue("configured");
    mocks.aiGenerate.mockRejectedValue(new Error("provider unavailable"));
    mocks.aiJSON.mockRejectedValue(new Error("provider unavailable"));

    for (const mode of ALLOWED_AI_MODES) {
      const response = await POST(aiRequest({
        mode,
        text: "Private user content",
        body: "{}",
      }));

      expect(response.status, mode).toBe(200);
      expect((await response.json()).meta, mode).toEqual({
        source: "heuristic",
        degraded: true,
        reason: "provider_error",
      });
    }
  });

  it("distinguishes provider rate limiting from a generic provider error", async () => {
    mocks.optionalEnv.mockReturnValue("configured");
    mocks.aiJSON.mockRejectedValue(new Error("provider returned 429 rate limit"));

    const response = await POST(aiRequest({
      mode: "capture",
      text: "Follow up tomorrow",
    }));

    expect((await response.json()).meta).toEqual({
      source: "heuristic",
      degraded: true,
      reason: "provider_rate_limited",
    });
  });
});
