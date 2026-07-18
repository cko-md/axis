import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { optionalEnv } from "@/lib/env";
import { memoryRateLimit } from "@/lib/ratelimit";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import type { Json } from "@/lib/supabase/database.types";
import { TOOLS, CITATION_TOOL, executeTool } from "@/lib/ai/tools/registry";

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

function advisorFailure(error: unknown, operation: string) {
  captureRouteError(error, { route: "/api/fund/advisor", operation, area: "fund", status: 500 });
  return NextResponse.json({ error: "ADVISOR_UNAVAILABLE" }, { status: 500 });
}

const SYSTEM_PROMPT = `You are the financial advisor inside Axis, a personal operating system. You help the user understand their own spending, holdings, liabilities, and cash position.

Rules, no exceptions:
- Never state a number that did not come from a tool result earlier in this turn. If you don't know, call a tool.
- There is no tool to buy, sell, trade, or transfer anything. If asked to do so, say plainly that you can't place trades and point the user to their brokerage app — do not apologize at length, just state it and move on.
- If a tool result indicates data is unavailable (e.g. quote_available: false, POLYGON_API_KEY_NOT_CONFIGURED), say so rather than guessing.
- Chain tool calls when a question needs more than one fact (e.g. "can I afford X" needs compute_safe_to_invest).
- Once you've called any data tool, you must end the turn by calling respond_with_citation — do not just write prose after fetching data.
- Keep answers concise and concrete. Cite the actual figures, not vague ranges.`;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY_NOT_CONFIGURED" }, { status: 503 });
  }

  const { success } = memoryRateLimit(`advisor:${user.id}`, 20, 60_000);
  if (!success) return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });

  const { conversation_id, message } = (await req.json().catch(() => ({}))) as {
    conversation_id?: string;
    message?: string;
  };
  const userMessage = String(message ?? "").trim();
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
  const messages: Anthropic.MessageParam[] = [
    ...(priorMessages ?? [])
      .filter((m) => m.content)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string })),
    { role: "user", content: userMessage },
  ];

  const { error: userMessageError } = await supabase.from("ai_messages").insert({ conversation_id: conversationId, user_id: user.id, role: "user", content: userMessage });
  if (userMessageError) return advisorFailure(userMessageError, "persist_user_message");

  const allTools = [...TOOLS, CITATION_TOOL];
  let toolCallCount = 0;
  let usedAnyTool = false;
  let citation: Record<string, unknown> | null = null;
  let finalText = "";

  for (let round = 0; round < MAX_TOOL_CALLS + 2; round++) {
    const forceToolChoice = toolCallCount >= MAX_TOOL_CALLS ? { type: "tool" as const, name: CITATION_TOOL.name } : usedAnyTool ? { type: "any" as const } : { type: "auto" as const };

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: allTools,
      tool_choice: forceToolChoice,
      messages,
    });

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");

    if (toolUseBlocks.length === 0) {
      finalText = textBlocks.map((b) => b.text).join("\n").trim();
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.name === CITATION_TOOL.name) {
        citation = block.input as Record<string, unknown>;
        finalText = String(citation.summary ?? "");
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
      } catch {
        isError = true;
        output = { error: "TOOL_EXECUTION_FAILED" };
      }
      const latencyMs = Date.now() - startedAt;

      const { error: toolCallError } = await supabase.from("ai_tool_calls").insert({
        user_id: user.id,
        conversation_id: conversationId,
        tool_name: block.name,
        input: block.input as Json,
        output: output as Json,
        latency_ms: latencyMs,
      });
      if (toolCallError) return advisorFailure(toolCallError, "persist_tool_call");

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(output),
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });

    if (citation) break;
  }

  if (!finalText) {
    finalText = "I wasn't able to settle on an answer in the allotted tool calls — try narrowing the question.";
  }

  const toolCallsForStorage: { citation: Record<string, unknown> | null; tool_call_count: number } = {
    citation,
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

  return NextResponse.json({
    conversation_id: conversationId,
    message_id: savedAssistant?.id,
    text: finalText,
    citation,
    tool_call_count: toolCallCount,
  });
}
