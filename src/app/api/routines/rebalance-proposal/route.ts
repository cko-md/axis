import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { proposeRebalance, type RebalanceAction } from "@/lib/skills/rebalanceProposal";
import { describeOrderTicket } from "@/lib/orders/orderTicket";
import { resolveMarketDataAdapter } from "@/lib/markets/adapter";
import type { MarketQuote } from "@/lib/markets/quote";
import { classifyFreshness, FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import {
  createObservabilityRequestId,
  emitServerEvent,
  routineEventErrorCode,
  routineEventStage,
} from "@/lib/observability/events";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { explainWithCost } from "@/lib/ai/explain";
import { REBALANCE_PROPOSAL_CURRENT_VERSION } from "@/lib/routines/versioning";

/**
 * Deterministic rebalance simulation. This route produces durable order drafts
 * only: live broker submission is deliberately unavailable, so it must never
 * create execution approvals or imply that an order has been submitted.
 */

const ROUTINE_KEY = "rebalance_proposal";
const ROUTE = "api.routines.rebalance-proposal";
const SYMBOL_RE = /^[A-Z0-9.:-]{1,12}$/;
const MAX_TARGET_SYMBOLS = 50;
const DEFAULT_DRIFT_THRESHOLD = 0.05;
const DEFAULT_MIN_TRADE_VALUE = 1;
const TARGET_SUM_EPSILON = 1e-9;

const requestSchema = z.object({
  targets: z.record(z.number().finite().min(0).max(1)),
  driftThreshold: z.number().finite().min(0).max(1).optional(),
  minTradeValue: z.number().finite().min(0).optional(),
  includeNarrative: z.boolean().optional(),
}).strict();

type NormalizedInput = {
  targets: Record<string, number>;
  driftThreshold: number;
  minTradeValue: number;
  includeNarrative: boolean;
  targetWeightTotal: number;
  cashRemainderWeight: number;
  allocationIntent: "all_cash" | "partial_cash" | "fully_invested";
};

type QuoteBasis = {
  price: number;
  currency: string;
  freshness: "fresh" | "delayed";
  provider: string;
  retrievedAt: string;
  effectiveAt?: string;
};

type BlockedErrorOptions = {
  code: string;
  message: string;
  operation: string;
  status?: number;
  tags?: Record<string, string | number | boolean>;
};

class RebalanceBlockedError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly status: number;
  readonly tags: Record<string, string | number | boolean>;

  constructor(options: BlockedErrorOptions) {
    super(options.message);
    this.name = "RebalanceBlockedError";
    this.code = options.code;
    this.operation = options.operation;
    this.status = options.status ?? 500;
    this.tags = options.tags ?? {};
  }
}

function roundWeight(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeSymbol(value: string): string | null {
  const symbol = value.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

function normalizeInput(raw: unknown):
  | { ok: true; value: NormalizedInput }
  | { ok: false; message: string } {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Targets, driftThreshold, and minTradeValue must be finite values within their allowed ranges.",
    };
  }

  const entries = Object.entries(parsed.data.targets);
  if (entries.length === 0 || entries.length > MAX_TARGET_SYMBOLS) {
    return {
      ok: false,
      message: `Provide between 1 and ${MAX_TARGET_SYMBOLS} target symbols.`,
    };
  }

  const targets: Record<string, number> = {};
  for (const [rawSymbol, weight] of entries) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol || Object.hasOwn(targets, symbol)) {
      return {
        ok: false,
        message: "Target symbols must be unique valid market symbols.",
      };
    }
    targets[symbol] = weight;
  }

  const targetWeightTotal = Object.values(targets).reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(targetWeightTotal) || targetWeightTotal > 1 + TARGET_SUM_EPSILON) {
    return {
      ok: false,
      message: "Target weights must total no more than 1; any remainder is treated as cash.",
    };
  }

  const normalizedTotal = roundWeight(Math.min(1, targetWeightTotal));
  return {
    ok: true,
    value: {
      targets,
      driftThreshold: parsed.data.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD,
      minTradeValue: parsed.data.minTradeValue ?? DEFAULT_MIN_TRADE_VALUE,
      includeNarrative: parsed.data.includeNarrative ?? false,
      targetWeightTotal: normalizedTotal,
      cashRemainderWeight: roundWeight(1 - normalizedTotal),
      allocationIntent:
        normalizedTotal === 0
          ? "all_cash"
          : normalizedTotal < 1
            ? "partial_cash"
            : "fully_invested",
    },
  };
}

function validateQuote(symbol: string, quote: MarketQuote): QuoteBasis | null {
  const quoteSymbol = normalizeSymbol(quote.symbol);
  if (quoteSymbol !== symbol) return null;
  if (!Number.isFinite(quote.price) || quote.price <= 0) return null;
  if (quote.freshness !== "fresh" && quote.freshness !== "delayed") return null;
  if (quote.currency !== "USD") return null;
  const now = Date.now();
  const retrievedAtMs = Date.parse(quote.provenance.retrievedAt);
  if (!Number.isFinite(retrievedAtMs) || retrievedAtMs > now + 60_000) return null;
  if (
    quote.provenance.effectiveAt
    && !Number.isFinite(Date.parse(quote.provenance.effectiveAt))
  ) {
    return null;
  }
  const derivedFreshness = classifyFreshness(
    quote.provenance.effectiveAt ?? quote.provenance.retrievedAt,
    FRESHNESS_SLAS.marketPrice,
    now,
  );
  if (derivedFreshness !== "fresh" && derivedFreshness !== "delayed") return null;
  const freshness =
    quote.freshness === "delayed" || derivedFreshness === "delayed"
      ? "delayed"
      : "fresh";

  return {
    price: quote.price,
    currency: quote.currency,
    freshness,
    provider: quote.provenance.provider,
    retrievedAt: quote.provenance.retrievedAt,
    ...(quote.provenance.effectiveAt ? { effectiveAt: quote.provenance.effectiveAt } : {}),
  };
}

async function isWithinRateLimit(userId: string, requestId: string): Promise<boolean> {
  try {
    const distributed = await redisRateLimit(userId, 5, "1 m", "axis:rebalance-proposal");
    if (distributed) return distributed.success;
  } catch (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "rate_limit_backend",
      area: "routines",
      status: 500,
      code: "RATE_LIMIT_BACKEND_FAILED",
      tags: { requestId },
    });
  }
  return memoryRateLimit(`rebalance-proposal:${userId}`, 5, 60_000).success;
}

export async function POST(request: NextRequest) {
  const requestId = createObservabilityRequestId();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const normalized = normalizeInput(await request.json().catch(() => null));
  if (!normalized.ok) {
    return NextResponse.json(
      { error: "INVALID_ROUTINE_INPUT", message: normalized.message },
      { status: 400 },
    );
  }
  const input = normalized.value;

  const withinRateLimit = await isWithinRateLimit(user.id, requestId);
  if (!withinRateLimit) {
    return NextResponse.json(
      {
        error: "RATE_LIMITED",
        message: "Too many rebalance simulations. Try again in a minute.",
      },
      { status: 429 },
    );
  }

  const adapter = resolveMarketDataAdapter();
  if (!adapter.isConfigured()) {
    const error = new Error("Market data adapter is not configured");
    captureRouteError(error, {
      route: ROUTE,
      operation: "configure_market_data",
      area: "routines",
      provider: adapter.provider,
      status: 503,
      code: "MARKET_DATA_REQUIRED",
      tags: { requestId },
    });
    return NextResponse.json(
      {
        error: "MARKET_DATA_REQUIRED",
        message: "A complete fresh or delayed quote set is required to simulate a rebalance.",
      },
      { status: 503 },
    );
  }

  const inputSnapshot = {
    mode: "simulate",
    targets: input.targets,
    driftThreshold: input.driftThreshold,
    minTradeValue: input.minTradeValue,
    includeNarrative: input.includeNarrative,
    targetAllocation: {
      targetWeightTotal: input.targetWeightTotal,
      cashRemainderWeight: input.cashRemainderWeight,
      cashRemainderPolicy: "unallocated_target_weight_is_cash",
      allocationIntent: input.allocationIntent,
    },
    submissionEnabled: false,
    approvalRequiredForSubmission: true,
  } as unknown as Json;

  const { data: run, error: runError } = await supabase
    .from("routine_runs")
    .insert({
      user_id: user.id,
      routine_key: ROUTINE_KEY,
      routine_version: REBALANCE_PROPOSAL_CURRENT_VERSION,
      status: "running",
      trigger: "manual",
      input_snapshot: inputSnapshot,
      estimated_cost_usd: 0,
    })
    .select("id")
    .single();
  if (runError || !run) {
    captureRouteError(runError ?? new Error("Routine run was not returned"), {
      route: ROUTE,
      operation: "start_run",
      area: "routines",
      status: 500,
      code: "RUN_START_FAILED",
      tags: { requestId },
    });
    return NextResponse.json(
      { error: "RUN_START_FAILED", message: "The rebalance simulation could not be started." },
      { status: 500 },
    );
  }

  const runId = run.id;
  let ordinal = 0;
  let activeStep: string | null = null;
  let activeStepInput: Json = {};
  let failureStepRecorded = false;

  async function recordStep(
    stepKey: string,
    status: "succeeded" | "failed",
    stepInput: Json,
    output: Json,
    errorCode?: string,
  ) {
    const nextOrdinal = ordinal + 1;
    const { error } = await supabase.from("routine_step_runs").insert({
      run_id: runId,
      user_id: user!.id,
      step_key: stepKey,
      ordinal: nextOrdinal,
      status,
      input_snapshot: stepInput,
      output_snapshot: output,
      error: errorCode ?? null,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    if (error) {
      throw new RebalanceBlockedError({
        code: "STEP_PERSISTENCE_FAILED",
        message: "The simulation audit trail could not be persisted.",
        operation: "persist_step",
        tags: { stepKey },
      });
    }
    ordinal = nextOrdinal;
    if (status === "failed") failureStepRecorded = true;
  }

  try {
    activeStep = "load_holdings";
    activeStepInput = {};
    const { data: holdingRows, error: holdingsError } = await supabase
      .from("fund_holdings")
      .select("symbol, shares")
      .eq("user_id", user.id);
    if (holdingsError) {
      throw new RebalanceBlockedError({
        code: "HOLDINGS_UNAVAILABLE",
        message: "Portfolio holdings are temporarily unavailable.",
        operation: activeStep,
      });
    }

    const sharesBySymbol = new Map<string, number>();
    for (const row of holdingRows ?? []) {
      const symbol = normalizeSymbol(row.symbol);
      const shares = Number(row.shares);
      if (!symbol || !Number.isFinite(shares) || shares < 0) {
        throw new RebalanceBlockedError({
          code: "INVALID_HOLDING",
          message: "A portfolio holding is invalid and must be corrected before simulation.",
          operation: activeStep,
        });
      }
      if (shares > 0) {
        sharesBySymbol.set(symbol, (sharesBySymbol.get(symbol) ?? 0) + shares);
      }
    }

    const symbols = [...new Set([...sharesBySymbol.keys(), ...Object.keys(input.targets)])].sort();
    await recordStep(
      activeStep,
      "succeeded",
      activeStepInput,
      { heldSymbols: sharesBySymbol.size, requiredQuotes: symbols.length } as Json,
    );

    activeStep = "load_prices";
    activeStepInput = { requiredQuotes: symbols.length } as Json;
    const settledQuotes = await Promise.all(symbols.map(async (symbol) => {
      try {
        return { symbol, result: await adapter.getQuote(symbol) } as const;
      } catch {
        return { symbol, result: null } as const;
      }
    }));

    const prices: Record<string, number> = {};
    const quoteBasis: Record<string, QuoteBasis> = {};
    const failureCodes: string[] = [];
    for (const { symbol, result } of settledQuotes) {
      if (!result?.ok) {
        failureCodes.push(result?.error.code ?? "adapter_exception");
        continue;
      }
      const quote = validateQuote(symbol, result.data);
      if (!quote) {
        const code =
          result.data.freshness === "stale" || result.data.freshness === "unknown"
            ? `unacceptable_${result.data.freshness}`
            : "invalid_quote";
        failureCodes.push(code);
        continue;
      }
      prices[symbol] = quote.price;
      quoteBasis[symbol] = quote;
    }

    if (failureCodes.length > 0 || Object.keys(prices).length !== symbols.length) {
      const uniqueFailureCodes = [...new Set(failureCodes)].sort();
      await recordStep(
        activeStep,
        "failed",
        activeStepInput,
        {
          requiredQuotes: symbols.length,
          acceptedQuotes: Object.keys(prices).length,
          failureCount: failureCodes.length,
          failureCodes: uniqueFailureCodes,
        } as unknown as Json,
        "MARKET_DATA_INCOMPLETE",
      );
      throw new RebalanceBlockedError({
        code: "MARKET_DATA_INCOMPLETE",
        message: "A complete set of positive fresh or delayed USD quotes is required. No proposal was produced.",
        operation: activeStep,
        status: 503,
        tags: {
          requiredQuotes: symbols.length,
          acceptedQuotes: Object.keys(prices).length,
          failureCount: failureCodes.length,
          failureCodes: uniqueFailureCodes.join(","),
        },
      });
    }

    const overallFreshness: "fresh" | "delayed" =
      Object.values(quoteBasis).some((quote) => quote.freshness === "delayed")
        ? "delayed"
        : "fresh";
    const oldestRetrievedAtMs = Math.min(
      ...Object.values(quoteBasis).map((quote) => Date.parse(quote.retrievedAt)),
    );
    const oldestRetrievedAt = Number.isFinite(oldestRetrievedAtMs)
      ? new Date(oldestRetrievedAtMs).toISOString()
      : null;
    await recordStep(
      activeStep,
      "succeeded",
      activeStepInput,
      {
        acceptedQuotes: Object.keys(prices).length,
        freshness: overallFreshness,
        oldestRetrievedAt,
      } as Json,
    );

    activeStep = "propose_rebalance";
    activeStepInput = { positions: sharesBySymbol.size, targetSymbols: Object.keys(input.targets).length } as Json;
    const positions = [...sharesBySymbol.entries()]
      .map(([symbol, shares]) => ({ symbol, value: shares * prices[symbol] }))
      .filter((position) => position.value > 0);
    const proposal = proposeRebalance(
      { positions, targets: input.targets, prices },
      {
        driftThreshold: input.driftThreshold,
        minTradeValue: input.minTradeValue,
      },
    );
    const orderDrafts = (proposal.actions as RebalanceAction[]).map((action) => ({
      symbol: action.symbol,
      side: action.side,
      currentValue: action.currentValue,
      currentWeight: action.currentWeight,
      targetWeight: action.targetWeight,
      tradeValue: action.tradeValue,
      ticket: action.ticket,
      executionStatus: "not_submitted" as const,
    }));
    await recordStep(
      activeStep,
      "succeeded",
      activeStepInput,
      {
        portfolioMarketValue: proposal.total,
        orderDrafts,
        skipped: proposal.skipped,
      } as unknown as Json,
    );

    let narrative: string | null = null;
    let actualCost = 0;
    if (input.includeNarrative && orderDrafts.length > 0) {
      activeStep = "explain_proposal";
      activeStepInput = { orderDrafts: orderDrafts.length } as Json;
      const summary = proposal.actions
        .map((action) =>
          `${describeOrderTicket(action.ticket)} (now ${(action.currentWeight * 100).toFixed(1)}% -> target ${(action.targetWeight * 100).toFixed(1)}%)`)
        .join("; ");
      const explained = await explainWithCost({
        system: "Explain this deterministic rebalance simulation in 2-3 plain sentences. Do not invent, recompute, recommend, or imply that any order was submitted.",
        userMessage: `Draft orders: ${summary}. Invested holdings market value ~$${Math.round(proposal.total)}. These drafts have not been submitted.`,
      });
      if (!explained.skipped) {
        narrative = explained.text;
        actualCost = explained.estimatedCostUsd;
      }
      await recordStep(
        activeStep,
        "succeeded",
        activeStepInput,
        {
          skipped: explained.skipped,
          estimatedCostUsd: actualCost,
        } as Json,
      );
    }

    const output = {
      mode: "simulate",
      simulationOnly: true,
      total: proposal.total,
      proposed: orderDrafts.length,
      orderDrafts,
      skipped: proposal.skipped,
      targetAllocation: {
        targetWeightTotal: input.targetWeightTotal,
        cashRemainderWeight: input.cashRemainderWeight,
        cashRemainderPolicy: "unallocated_target_weight_is_cash",
        allocationIntent: input.allocationIntent,
        basis: "invested_holdings_market_value",
      },
      quoteSet: {
        provider: adapter.provider,
        freshness: overallFreshness,
        oldestRetrievedAt,
        quotes: quoteBasis,
      },
      narrative,
      submissionEnabled: false,
      approvalRequiredForSubmission: true,
      executionStatus: "not_submitted",
    };
    activeStep = null;
    const { error: completionError } = await supabase
      .from("routine_runs")
      .update({
        status: "completed",
        output: output as unknown as Json,
        actual_cost_usd: actualCost,
        completed_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", runId)
      .eq("user_id", user.id);
    if (completionError) {
      throw new RebalanceBlockedError({
        code: "RUN_COMPLETION_FAILED",
        message: "The simulation result could not be persisted.",
        operation: "complete_run",
      });
    }

    emitServerEvent("routine.run.completed", {
      requestId,
      routine: ROUTINE_KEY,
      runId,
      status: "completed",
      proposals: orderDrafts.length,
      simulationOnly: true,
      submissionEnabled: false,
      executionStatus: "not_submitted",
    });

    return NextResponse.json({ runId, status: "completed", ...output });
  } catch (error) {
    const blocked = error instanceof RebalanceBlockedError
      ? error
      : new RebalanceBlockedError({
        code: "RUN_BLOCKED",
        message: "The rebalance simulation was blocked before a proposal could be completed.",
        operation: activeStep ?? "run",
      });

    if (activeStep && !failureStepRecorded && blocked.code !== "STEP_PERSISTENCE_FAILED") {
      try {
        await recordStep(
          activeStep,
          "failed",
          activeStepInput,
          { error: blocked.code } as Json,
          blocked.code,
        );
      } catch (stepError) {
        captureRouteError(stepError, {
          route: ROUTE,
          operation: "persist_failed_step",
          area: "routines",
          provider: adapter.provider,
          status: 500,
          code: "STEP_PERSISTENCE_FAILED",
          tags: { requestId, failedOperation: blocked.operation },
        });
      }
    }

    const { error: blockPersistenceError } = await supabase
      .from("routine_runs")
      .update({ status: "blocked", error: blocked.code })
      .eq("id", runId)
      .eq("user_id", user.id);
    let responseError = blocked;
    if (blockPersistenceError) {
      captureRouteError(blockPersistenceError, {
        route: ROUTE,
        operation: "persist_blocked_run",
        area: "routines",
        status: 500,
        code: "RUN_BLOCK_PERSISTENCE_FAILED",
        tags: { requestId, failedOperation: blocked.operation },
      });
      responseError = new RebalanceBlockedError({
        code: "RUN_BLOCK_PERSISTENCE_FAILED",
        message: "The simulation stopped, but its blocked status could not be persisted.",
        operation: "persist_blocked_run",
      });
    }

    captureRouteError(error, {
      route: ROUTE,
      operation: blocked.operation,
      area: "routines",
      provider: adapter.provider,
      status: blocked.status,
      code: blocked.code,
      tags: { ...blocked.tags, requestId },
    });
    emitServerEvent("routine.run.blocked", {
      requestId,
      routine: ROUTINE_KEY,
      runId,
      errorCode: routineEventErrorCode(blocked.code),
      stage: routineEventStage(blocked.operation),
      resumedFromApproval: false,
    });

    return NextResponse.json(
      {
        error: responseError.code,
        message: responseError.message,
        runId,
        resumable: false,
        retryStrategy: "start_new_run",
      },
      { status: responseError.status },
    );
  }
}
