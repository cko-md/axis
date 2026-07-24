import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { optionalEnv } from "@/lib/env";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import type { Json } from "@/lib/supabase/database.types";
import { TOOLS, CITATION_TOOL, executeTool } from "@/lib/ai/tools/registry";
import {
  combineAdvisorEvidence,
  renderAdvisorEvidence,
  type AdvisorEvidence,
  type AdvisorEvidenceResult,
} from "@/lib/ai/tools/advisorEvidence";
import { readBoundedJson } from "@/lib/http/boundedJson";

/**
 * FIN-502: Advisor chat — the only conversational entry point with real
 * tool-calling. Bypasses src/lib/ai/router.ts on purpose: that router's
 * Gemini tier has no tool-use support, and Advisor quality/safety matter
 * more than routing cost here.
 *
 * Safety design (Phase 5):
 *  - TOOLS is read-only. There is no write/trade tool in the list the model
 *    can see, so it cannot place an order no matter what it's asked.
 *  - Once any data tool has been called this turn, every subsequent model
 *    call forces tool_choice to "any" — the model can call another tool or
 *    respond_with_citation, but it cannot slip back to free prose. The only
 *    way to end a data-backed turn is through the citation tool, so every
 *    quantitative answer carries data_sources/assumptions/confidence/
 *    requires_review. Turns that never touch a tool (e.g. "what's a P/E
 *    ratio") can end in plain text — they make no numeric claim about the
 *    user's own data.
 *  - Hard cap of 6 tool calls per turn — a runaway-loop guard, not a
 *    suggestion.
 */

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_CALLS = 6;
const MAX_TOOL_BLOCKS_PER_RESPONSE = 8;
const MAX_TOOL_BLOCKS_PER_TURN = 12;
const MAX_REQUEST_BYTES = 16_384;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_BYTES = 16_384;
const MAX_TOOL_INPUT_BYTES = 4_096;
const MAX_SINGLE_TOOL_RESULT_BYTES = 6_144;
const MAX_TOOL_RESULT_CONTEXT_BYTES = 16_384;
const MAX_MODEL_CONTEXT_BYTES = 65_536;
const MAX_CITATION_SUMMARY_CHARS = 3_000;
const MAX_CITATION_ASSUMPTIONS_CHARS = 1_000;
const MAX_CITATION_SOURCES = 12;
const MAX_CITATION_SOURCE_CHARS = 200;
const TOOL_RESULT_TOO_LARGE = { error: "TOOL_RESULT_TOO_LARGE" } as const;

type AdvisorCitation = {
  summary: string;
  data_sources: string[];
  assumptions: string;
  confidence: "high" | "medium" | "low";
  requires_review: boolean;
};

type ValidatedCitation = {
  citation: AdvisorCitation;
  evidence: AdvisorEvidence[];
};

const CITATION_KEYS = new Set([
  "summary",
  "data_sources",
  "assumptions",
  "confidence",
  "requires_review",
]);

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function serializeToolOutput(output: unknown): {
  content: string;
  storage: Json;
  tooLarge: boolean;
} {
  try {
    const content = JSON.stringify(output);
    if (typeof content === "string" && byteLength(content) <= MAX_SINGLE_TOOL_RESULT_BYTES) {
      return { content, storage: output as Json, tooLarge: false };
    }
  } catch {
    // Non-JSON provider output crosses neither the model nor persistence
    // boundary; it is represented as a safe tool failure below.
  }
  const content = JSON.stringify(TOOL_RESULT_TOO_LARGE);
  return { content, storage: TOOL_RESULT_TOO_LARGE, tooLarge: true };
}

function normalizeToolFailure(error: unknown) {
  if (
    error
    && typeof error === "object"
    && "name" in error
    && error.name === "ToolExecutionError"
    && "code" in error
    && ["INVALID_INPUT", "DATA_UNAVAILABLE", "PROVIDER_UNAVAILABLE"].includes(
      String(error.code),
    )
  ) {
    return { error: String(error.code) };
  }
  return { error: "TOOL_EXECUTION_FAILED" };
}

function validateCitationUnsafe(
  value: unknown,
  completedEvidence: ReadonlyMap<string, readonly AdvisorEvidence[]>,
): ValidatedCitation | null {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== CITATION_KEYS.size
    || keys.some((key) => !CITATION_KEYS.has(key))
  ) {
    return null;
  }

  const summary =
    typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const assumptions =
    typeof candidate.assumptions === "string"
      ? candidate.assumptions.trim()
      : null;
  if (
    !summary
    || summary.length > MAX_CITATION_SUMMARY_CHARS
    || assumptions === null
    || assumptions.length > MAX_CITATION_ASSUMPTIONS_CHARS
    || !Array.isArray(candidate.data_sources)
    || Object.getPrototypeOf(candidate.data_sources) !== Array.prototype
    || candidate.data_sources.length === 0
    || candidate.data_sources.length > MAX_CITATION_SOURCES
    || typeof candidate.confidence !== "string"
    || !["high", "medium", "low"].includes(candidate.confidence)
    || typeof candidate.requires_review !== "boolean"
  ) {
    return null;
  }

  const sources: string[] = [];
  for (const source of candidate.data_sources) {
    if (
      typeof source !== "string"
      || !source
      || source.length > MAX_CITATION_SOURCE_CHARS
      || !completedEvidence.has(source)
      || sources.includes(source)
    ) {
      return null;
    }
    sources.push(source);
  }
  const serverSources = [...completedEvidence.keys()];
  if (
    sources.length !== serverSources.length
    || serverSources.some((source) => !sources.includes(source))
  ) {
    return null;
  }

  const evidence = serverSources.flatMap(
    (source) => completedEvidence.get(source) ?? [],
  );
  const summaryText = combineAdvisorEvidence(evidence);
  if (!summaryText) return null;

  // Model-authored financial prose is never the grounded result. The citation
  // tool is only a terminal signal selecting the exact completed evidence set;
  // typed server renderers emit the verified facts and server-owned metadata.
  return {
    citation: {
      summary: summaryText,
      data_sources: serverSources,
      assumptions:
        "Figures are deterministic renderings of verified tool results; provider freshness and coverage may vary.",
      confidence: "medium",
      requires_review: true,
    },
    evidence,
  };
}

function validateCitation(
  value: unknown,
  completedEvidence: ReadonlyMap<string, readonly AdvisorEvidence[]>,
): ValidatedCitation | null {
  try {
    return validateCitationUnsafe(value, completedEvidence);
  } catch {
    return null;
  }
}

function advisorFailure(_error: unknown, operation: string, status = 500) {
  captureRouteError(new Error("Advisor operation failed"), {
    route: "/api/fund/advisor",
    operation,
    area: "fund",
    status,
    code: "ADVISOR_UNAVAILABLE",
  });
  return NextResponse.json({ error: "ADVISOR_UNAVAILABLE" }, { status });
}

function advisorToolLimit() {
  captureRouteError(new Error("Advisor tool boundary exceeded"), {
    route: "/api/fund/advisor",
    operation: "bound_tool_blocks",
    area: "fund",
    status: 503,
    code: "ADVISOR_TOOL_LIMIT",
  });
  return NextResponse.json({ error: "ADVISOR_TOOL_LIMIT" }, { status: 503 });
}

function advisorContextLimit(operation: string) {
  captureRouteError(new Error("Advisor context boundary exceeded"), {
    route: "/api/fund/advisor",
    operation,
    area: "fund",
    status: 503,
    code: "ADVISOR_CONTEXT_LIMIT",
  });
  return NextResponse.json({ error: "ADVISOR_CONTEXT_LIMIT" }, { status: 503 });
}

function advisorEvidenceFailure(
  failure: Extract<AdvisorEvidenceResult, { ok: false }>,
) {
  captureRouteError(new Error("Advisor evidence could not be rendered"), {
    route: "/api/fund/advisor",
    operation: "render_evidence",
    area: "fund",
    status: 503,
    code: failure.code,
  });
  return NextResponse.json(
    { error: "ADVISOR_EVIDENCE_UNAVAILABLE" },
    { status: 503 },
  );
}

const SYSTEM_PROMPT = `You are the financial advisor inside Axis, a personal operating system. You help the user understand their own spending, holdings, liabilities, and cash position.

Rules, no exceptions:
- Never state a number that did not come from a tool result earlier in this turn. If you don't know, call a tool.
- There is no tool to buy, sell, trade, or transfer anything. If asked to do so, say plainly that you can't place trades and point the user to their brokerage app — do not apologize at length, just state it and move on.
- If a tool result indicates data is unavailable (e.g. quote_available: false, POLYGON_API_KEY_NOT_CONFIGURED), say so rather than guessing.
- Chain tool calls when a question needs more than one fact (e.g. "can I afford X" needs compute_safe_to_invest).
- Once you've called any data tool, you must end the turn by calling respond_with_citation — do not just write prose after fetching data.
- Every successful turn must call at least one read-only data tool and then respond_with_citation. Plain prose cannot terminate a turn.
- In data_sources, use the exact names of the completed tools whose results support the answer.
- Keep answers concise and concrete. Cite the actual figures, not vague ranges.`;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY_NOT_CONFIGURED" }, { status: 503 });
  }

  const admission = await admit(user.id, { ...ADMISSION_POLICIES.financial, name: "fund-advisor" });
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });
  const raw = await readBoundedJson(req, MAX_REQUEST_BYTES);
  if (!raw.ok) return NextResponse.json({ error: raw.status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_BODY" }, { status: raw.status });
  const parsed = raw.value as {
    conversation_id?: string;
    message?: string;
  } | null;
  if (!parsed || typeof parsed.message !== "string") return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  const { conversation_id, message } = parsed;
  if (message.length > MAX_MESSAGE_CHARS) return NextResponse.json({ error: "MESSAGE_TOO_LARGE" }, { status: 413 });
  const userMessage = message.trim();
  if (!userMessage) return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });

  let conversationId = conversation_id;
  if (conversationId) {
    const { data: conv, error: conversationLookupError } = await supabase.from("ai_conversations").select("id").eq("id", conversationId).eq("user_id", user.id).maybeSingle();
    if (conversationLookupError) return advisorFailure(conversationLookupError, "load_conversation");
    if (!conv) return NextResponse.json({ error: "CONVERSATION_NOT_FOUND" }, { status: 404 });
  } else {
    const { data: conv, error } = await supabase
      .from("ai_conversations")
      .insert({ user_id: user.id, title: userMessage.slice(0, 80) })
      .select("id")
      .single();
    if (error) return advisorFailure(error, "create_conversation");
    conversationId = conv.id;
  }

  // MVP simplification: history is replayed as plain user/assistant text
  // turns, not raw tool_use blocks — if an earlier answer needs re-checking
  // this turn, the model just calls the tool again rather than reusing a
  // stale value. Keeps cross-request replay simple without losing safety.
  const { data: priorMessages, error: priorMessagesError } = await supabase
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at")
    .limit(20);
  if (priorMessagesError) return advisorFailure(priorMessagesError, "load_messages");

  const anthropic = new Anthropic({ apiKey });
  let historyBytes = 0;
  const boundedHistory: Anthropic.MessageParam[] = [];
  for (const priorMessage of priorMessages ?? []) {
    if (!priorMessage.content) continue;
    const content = String(priorMessage.content).slice(0, 4_000);
    const contentBytes = new TextEncoder().encode(content).byteLength;
    if (historyBytes + contentBytes > MAX_HISTORY_BYTES) break;
    boundedHistory.push({ role: priorMessage.role as "user" | "assistant", content });
    historyBytes += contentBytes;
  }
  const messages: Anthropic.MessageParam[] = [
    ...boundedHistory,
    { role: "user", content: userMessage },
  ];
  let replayHistoryCount = boundedHistory.length;
  let toolContextBytes = 0;

  const { error: userMessageError } = await supabase.from("ai_messages").insert({ conversation_id: conversationId, user_id: user.id, role: "user", content: userMessage });
  if (userMessageError) return advisorFailure(userMessageError, "persist_user_message");

  const allTools = [...TOOLS, CITATION_TOOL];
  let toolCallCount = 0;
  let toolBlockCount = 0;
  let usedAnyTool = false;
  let retriedWithoutTool = false;
  const completedEvidence = new Map<string, AdvisorEvidence[]>();
  let finalEvidence: AdvisorEvidence[] = [];
  let citation: AdvisorCitation | null = null;
  let finalText = "";

  for (let round = 0; round < MAX_TOOL_CALLS + 2; round++) {
    const forceToolChoice =
      toolCallCount >= MAX_TOOL_CALLS
        ? { type: "tool" as const, name: CITATION_TOOL.name }
        : usedAnyTool || retriedWithoutTool
          ? { type: "any" as const }
          : { type: "auto" as const };
    while (byteLength(JSON.stringify(messages)) > MAX_MODEL_CONTEXT_BYTES && replayHistoryCount > 0) {
      messages.shift();
      replayHistoryCount--;
    }
    if (byteLength(JSON.stringify(messages)) > MAX_MODEL_CONTEXT_BYTES) {
      captureRouteError(new Error("Advisor model context limit reached"), {
        route: "/api/fund/advisor", operation: "bound_model_context",
        area: "fund", status: 503, code: "MODEL_CONTEXT_LIMIT",
      });
      return NextResponse.json({ error: "ADVISOR_CONTEXT_LIMIT" }, { status: 503 });
    }

    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: allTools,
        tool_choice: forceToolChoice,
        messages,
      });
    } catch {
      return advisorFailure(null, "generate_response", 503);
    }

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const dataToolBlocks = toolUseBlocks.filter((block) => block.name !== CITATION_TOOL.name);
    if (
      toolUseBlocks.length > MAX_TOOL_BLOCKS_PER_RESPONSE
      || toolBlockCount + toolUseBlocks.length > MAX_TOOL_BLOCKS_PER_TURN
      || toolCallCount + dataToolBlocks.length > MAX_TOOL_CALLS
    ) {
      return advisorToolLimit();
    }
    for (const block of toolUseBlocks) {
      let serializedInput: string;
      try {
        serializedInput = JSON.stringify(block.input);
      } catch {
        return advisorToolLimit();
      }
      if (byteLength(serializedInput) > MAX_TOOL_INPUT_BYTES) {
        return advisorToolLimit();
      }
    }
    toolBlockCount += toolUseBlocks.length;

    if (toolUseBlocks.length === 0) {
      if (usedAnyTool) {
        // Tool choice is a provider instruction, not a server authority. Once
        // evidence exists, free text cannot terminate the turn without the
        // structured citation ceremony.
        return advisorContextLimit("require_citation");
      }
      // Provider prose is not authority, even on an apparently qualitative
      // first turn. Retry once with a forced tool choice without replaying or
      // persisting the untrusted text; repeated noncompliance fails contained.
      if (retriedWithoutTool) {
        return advisorContextLimit("require_evidence");
      }
      retriedWithoutTool = true;
      continue;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    const hadCompletedEvidence = usedAnyTool;
    const hasSameRoundData = dataToolBlocks.length > 0;
    for (const block of toolUseBlocks) {
      if (block.name === CITATION_TOOL.name) {
        if (!hadCompletedEvidence || hasSameRoundData || citation) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: "CITATION_REQUIRES_COMPLETED_EVIDENCE" }),
            is_error: true,
          });
          continue;
        }
        const validated = validateCitation(
          block.input,
          completedEvidence,
        );
        if (!validated) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ error: "INVALID_CITATION" }),
            is_error: true,
          });
          continue;
        }
        citation = validated.citation;
        finalEvidence = validated.evidence;
        finalText = citation.summary;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Recorded." });
        continue;
      }

      usedAnyTool = true;
      toolCallCount++;
      const startedAt = Date.now();
      let output: unknown;
      let isError = false;
      try {
        output = await executeTool(block.name, block.input as Record<string, unknown>, { supabase, userId: user.id });
      } catch (error) {
        isError = true;
        output = normalizeToolFailure(error);
      }
      const latencyMs = Date.now() - startedAt;
      let serialized = serializeToolOutput(output);
      let candidate: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: block.id,
        content: serialized.content,
        is_error: isError || serialized.tooLarge,
      };
      const prospectiveToolContextBytes =
        toolContextBytes + byteLength(JSON.stringify([...toolResults, candidate]));
      if (prospectiveToolContextBytes > MAX_TOOL_RESULT_CONTEXT_BYTES) {
        serialized = {
          content: JSON.stringify(TOOL_RESULT_TOO_LARGE),
          storage: TOOL_RESULT_TOO_LARGE,
          tooLarge: true,
        };
        candidate = {
          type: "tool_result",
          tool_use_id: block.id,
          content: serialized.content,
          is_error: true,
        };
        const placeholderContextBytes =
          toolContextBytes
          + byteLength(JSON.stringify([...toolResults, candidate]));
        if (placeholderContextBytes > MAX_TOOL_RESULT_CONTEXT_BYTES) {
          return advisorContextLimit("bound_tool_context");
        }
      }
      const outputDeclaresError =
        output !== null
        && typeof output === "object"
        && !Array.isArray(output)
        && "error" in output;
      const { error: toolCallError } = await supabase.from("ai_tool_calls").insert({
        user_id: user.id,
        conversation_id: conversationId,
        tool_name: block.name,
        input: block.input as Json,
        output: serialized.storage,
        latency_ms: latencyMs,
      });
      if (toolCallError) return advisorFailure(toolCallError, "persist_tool_call");

      if (isError || serialized.tooLarge || outputDeclaresError) {
        return advisorEvidenceFailure({
          ok: false,
          code: "EVIDENCE_UNAVAILABLE",
        });
      }
      const rendered = renderAdvisorEvidence(block.name, output);
      if (!rendered.ok) return advisorEvidenceFailure(rendered);
      const priorEvidence = completedEvidence.get(block.name) ?? [];
      priorEvidence.push(rendered.evidence);
      completedEvidence.set(block.name, priorEvidence);

      toolResults.push(candidate);
    }

    const completedRoundBytes = byteLength(JSON.stringify(toolResults));
    if (
      toolContextBytes + completedRoundBytes
      > MAX_TOOL_RESULT_CONTEXT_BYTES
    ) {
      return advisorContextLimit("bound_tool_context");
    }
    toolContextBytes += completedRoundBytes;
    messages.push({ role: "user", content: toolResults });

    if (citation) break;
  }

  if (!usedAnyTool || !citation || !finalText) {
    return advisorContextLimit(
      usedAnyTool ? "require_citation" : "require_evidence",
    );
  }

  const toolCallsForStorage: {
    citation: AdvisorCitation | null;
    evidence: AdvisorEvidence[];
    tool_call_count: number;
  } = {
    citation,
    evidence: finalEvidence,
    tool_call_count: toolCallCount,
  };

  const { data: savedAssistant, error: assistantError } = await supabase
    .from("ai_messages")
    .insert({
      conversation_id: conversationId,
      user_id: user.id,
      role: "assistant",
      content: finalText,
      tool_calls: toolCallsForStorage as Json,
    })
    .select("id, created_at")
    .single();
  if (assistantError || !savedAssistant) return advisorFailure(assistantError ?? new Error("Assistant message was not persisted"), "persist_assistant_message");

  const { error: conversationUpdateError } = await supabase.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  if (conversationUpdateError) return advisorFailure(conversationUpdateError, "touch_conversation");

  return NextResponse.json<{
    conversation_id: string;
    message_id: string;
    text: string;
    citation: AdvisorCitation | null;
    evidence: AdvisorEvidence[];
    tool_call_count: number;
  }>({
    conversation_id: conversationId,
    message_id: savedAssistant?.id,
    text: finalText,
    citation,
    evidence: finalEvidence,
    tool_call_count: toolCallCount,
  });
}
