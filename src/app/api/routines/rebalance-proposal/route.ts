import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { proposeRebalance, type RebalanceAction } from "@/lib/skills/rebalanceProposal";
import { describeOrderTicket } from "@/lib/orders/orderTicket";
import { resolveMarketDataAdapter } from "@/lib/markets/adapter";
import { buildApprovalRequest, validateApprovalCompleteness } from "@/lib/security/approvalRequest";
import { approvalRequestToInsert } from "@/lib/security/approvalPersistence";
import { getBrokerageAccountId } from "@/lib/env";
import { emitServerEvent } from "@/lib/observability/events";
import { explainWithCost } from "@/lib/ai/explain";
import * as Sentry from "@sentry/nextjs";

/**
 * Rebalance-proposal routine (§15.3, §11) — the first routine that produces
 * REAL FINANCIAL_EXECUTION approvals and PAUSES for them (§15.5). It reads the
 * user's holdings, fetches live prices, runs the deterministic rebalance skill,
 * and creates one approval per proposed order — then sets the run to
 * `waiting_for_approval`. Nothing is submitted: the approvals are proposals the
 * user reviews (approve + passkey step-up + execute clears the gate; live order
 * submission is deliberately unbuilt — no autonomous execution).
 */

const ROUTINE_KEY = "rebalance_proposal";
const APPROVAL_TTL_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    targets?: Record<string, number>;
    driftThreshold?: number;
    minTradeValue?: number;
  };
  const targets = body.targets;
  if (!targets || typeof targets !== "object" || Object.keys(targets).length === 0) {
    return NextResponse.json({ error: "TARGETS_REQUIRED", message: "Provide a target allocation { SYMBOL: weight }." }, { status: 400 });
  }
  // Guard the weights.
  const weightSum = Object.values(targets).reduce((s, w) => s + (Number(w) || 0), 0);
  if (weightSum <= 0 || weightSum > 1.0001) {
    return NextResponse.json({ error: "INVALID_TARGETS", message: "Target weights must be > 0 and sum to <= 1." }, { status: 400 });
  }

  const adapter = resolveMarketDataAdapter();
  if (!adapter.isConfigured()) {
    return NextResponse.json({ error: "MARKET_DATA_REQUIRED", message: "Live prices are required to size a rebalance." }, { status: 503 });
  }

  const { data: run, error: runError } = await supabase
    .from("routine_runs")
    .insert({ user_id: user.id, routine_key: ROUTINE_KEY, status: "running", trigger: "manual", input_snapshot: { targets, driftThreshold: body.driftThreshold ?? null } as Json, estimated_cost_usd: 0 })
    .select("id")
    .single();
  if (runError || !run) return NextResponse.json({ error: "RUN_START_FAILED" }, { status: 500 });
  const runId = run.id;
  let ordinal = 0;

  async function recordStep(stepKey: string, status: "succeeded" | "failed", input: Json, output: Json, error?: string) {
    ordinal += 1;
    const { error: stepError } = await supabase.from("routine_step_runs").insert({
      run_id: runId, user_id: user!.id, step_key: stepKey, ordinal, status,
      input_snapshot: input, output_snapshot: output, error: error ?? null,
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    });
    if (stepError) throw new Error("STEP_RECORD_FAILED");
  }

  try {
    // 1) Holdings → shares by symbol.
    const { data: holdingRows, error: holdingsError } = await supabase
      .from("fund_holdings").select("symbol, shares").eq("user_id", user.id);
    if (holdingsError) throw new Error("HOLDINGS_UNAVAILABLE");
    const sharesBySymbol = new Map<string, number>();
    for (const r of holdingRows ?? []) sharesBySymbol.set(r.symbol, (sharesBySymbol.get(r.symbol) ?? 0) + Number(r.shares));
    const symbols = [...new Set([...sharesBySymbol.keys(), ...Object.keys(targets)])];
    await recordStep("load_holdings", "succeeded", {}, { symbols: symbols.length } as Json);

    // 2) Live prices for every symbol (holdings + targets).
    const prices: Record<string, number> = {};
    let freshness: "fresh" | "delayed" | "stale" | "unknown" = "fresh";
    let priceRetrievedAt = new Date().toISOString();
    for (const symbol of symbols) {
      const q = await adapter.getQuote(symbol);
      if (q.ok) {
        prices[symbol] = q.data.price;
        priceRetrievedAt = q.data.provenance.retrievedAt;
        if (q.data.freshness !== "fresh") freshness = q.data.freshness;
      }
    }
    await recordStep("load_prices", "succeeded", { symbols: symbols.length } as Json, { priced: Object.keys(prices).length } as Json);

    // 3) Deterministic proposal (current value = shares × live price).
    const positions = symbols
      .map((symbol) => ({ symbol, value: (sharesBySymbol.get(symbol) ?? 0) * (prices[symbol] ?? 0) }))
      .filter((p) => p.value > 0);
    const proposal = proposeRebalance({ positions, targets, prices }, { driftThreshold: body.driftThreshold, minTradeValue: body.minTradeValue });
    await recordStep("propose_rebalance", "succeeded", { positions: positions.length } as Json, { actions: proposal.actions.length, total: proposal.total } as Json);

    // 4) One FINANCIAL_EXECUTION approval per proposed order.
    const accountId = getBrokerageAccountId() ?? "unlinked-brokerage";
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    const created: { id: string; summary: string }[] = [];
    const incomplete: string[] = [];

    for (const action of proposal.actions as RebalanceAction[]) {
      const req = buildApprovalRequest({
        actor: { kind: "routine", id: ROUTINE_KEY, routineVersion: 1 },
        tool: "public.place_order",
        summary: describeOrderTicket(action.ticket),
        context: { actionClass: "FINANCIAL_EXECUTION", touchesSensitiveData: true },
        target: { entityType: "order", accountId },
        amount: { value: action.ticket.estimatedNotional, currency: action.ticket.currency, quantity: action.ticket.quantity },
        beforeState: { symbol: action.symbol, currentWeight: action.currentWeight, currentValue: action.currentValue },
        afterState: { targetWeight: action.targetWeight, ticket: action.ticket },
        dataFreshness: { tier: freshness, retrievedAt: priceRetrievedAt },
        scope: "one_time",
        expiresAt,
        taskId: undefined,
      });
      if (!validateApprovalCompleteness(req).complete) { incomplete.push(action.symbol); continue; }
      const insert = approvalRequestToInsert(req, user.id);
      const { data: appr, error: approvalError } = await supabase
        .from("approvals")
        .insert({ ...insert, proposed_action: insert.proposed_action as unknown as Json })
        .select("id")
        .single();
      if (approvalError || !appr) throw new Error("APPROVAL_CREATE_FAILED");
      if (appr) created.push({ id: appr.id, summary: req.summary });
    }
    await recordStep("create_approvals", "succeeded", { proposed: proposal.actions.length } as Json, { approvals: created.length, incomplete: incomplete.length } as Json);

    // 5) Optional AI narrative — EXPLAINS the deterministic proposal (never
    // computes it), metered. Skipped gracefully if no model is configured.
    let narrative: string | null = null;
    let actualCost = 0;
    if (proposal.actions.length > 0) {
      const summary = proposal.actions.map((a) => `${describeOrderTicket(a.ticket)} (now ${(a.currentWeight * 100).toFixed(1)}% -> target ${(a.targetWeight * 100).toFixed(1)}%)`).join("; ");
      const explained = await explainWithCost({
        system: "You explain a portfolio rebalance to its owner in 2-3 plain sentences. Do NOT invent or recompute any numbers; only restate and interpret what is given. No advice to buy/sell beyond what is listed.",
        userMessage: `Proposed trades to reach target weights: ${summary}. Portfolio total ~$${Math.round(proposal.total)}.`,
      });
      if (!explained.skipped) {
        narrative = explained.text;
        actualCost = explained.estimatedCostUsd;
      }
      await recordStep("explain_proposal", "succeeded", { actions: proposal.actions.length } as Json, { skipped: explained.skipped, estimatedCostUsd: actualCost } as Json);
    }

    // 6) Pause for approval (or complete if there was nothing to do).
    const status = created.length > 0 ? "waiting_for_approval" : "completed";
    const output = { total: proposal.total, proposed: proposal.actions.length, approvals: created, skipped: proposal.skipped, priceFreshness: freshness, narrative } as unknown as Json;
    const { error: completeError } = await supabase
      .from("routine_runs")
      .update({ status, output, actual_cost_usd: actualCost, ...(status === "completed" ? { completed_at: new Date().toISOString() } : {}) })
      .eq("user_id", user.id)
      .eq("id", runId);
    if (completeError) throw new Error("RUN_COMPLETE_FAILED");

    emitServerEvent("routine.run." + (status === "waiting_for_approval" ? "paused" : "completed"), {
      routine: ROUTINE_KEY, runId, status, proposed: proposal.actions.length, approvals: created.length,
    });

    return NextResponse.json({ runId, status, proposed: proposal.actions.length, approvals: created, skipped: proposal.skipped });
  } catch (err) {
    const failure = err instanceof Error ? err : new Error("run failed");
    Sentry.captureException(failure, {
      tags: { area: "routines", routine: ROUTINE_KEY, operation: "rebalance_proposal" },
      extra: { runId },
    });
    await supabase
      .from("routine_runs")
      .update({ status: "blocked", error: failure.message })
      .eq("user_id", user.id)
      .eq("id", runId);
    return NextResponse.json({ error: "RUN_BLOCKED", runId, resumable: true }, { status: 500 });
  }
}
