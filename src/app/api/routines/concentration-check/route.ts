import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { sumBy } from "@/lib/fund/money";
import { breachObjective, reviewConcentration, type Position } from "@/lib/skills/concentrationReview";

/**
 * Concentration-check routine (program §15.3) — a deterministic trigger that
 * turns a real portfolio into agent-Tasks. It reads the user's holdings, runs
 * the pure `reviewConcentration` skill (no model, no fabricated data), and
 * creates a `queued` agent-Task for each position over the target weight.
 *
 * Idempotent: a breach whose objective already has a non-terminal task is
 * skipped, so re-running doesn't pile up duplicates. It never trades or creates
 * a financial-execution approval — the output is a task to review, nothing more.
 */

const TERMINAL = ["completed", "failed", "cancelled"];

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { maxWeight?: number };
  const maxWeight = typeof body.maxWeight === "number" ? body.maxWeight : 0.25;

  const { data: holdingRows, error: holdingsError } = await supabase
    .from("fund_holdings")
    .select("symbol, cost_basis")
    .eq("user_id", user.id);
  if (holdingsError) return NextResponse.json({ error: "HOLDINGS_UNAVAILABLE" }, { status: 500 });

  // Aggregate by symbol (a symbol can appear once per source) — cost_basis is the
  // value proxy the Fund already uses.
  const bySymbol = new Map<string, number>();
  for (const row of holdingRows ?? []) {
    bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + Number(row.cost_basis));
  }
  const positions: Position[] = [...bySymbol.entries()].map(([symbol, value]) => ({ symbol, value }));

  const review = reviewConcentration(positions, maxWeight);
  if (review.breaches.length === 0) {
    return NextResponse.json({ total: review.total, breaches: 0, created: [], skipped: 0 });
  }

  // Skip breaches that already have an open task (idempotency).
  const { data: openTasks } = await supabase
    .from("agent_tasks")
    .select("objective, status")
    .eq("user_id", user.id)
    .not("status", "in", `(${TERMINAL.join(",")})`);
  const openObjectives = new Set((openTasks ?? []).map((t) => t.objective));

  const created: { id: string; objective: string }[] = [];
  let skipped = 0;

  for (const breach of review.breaches) {
    const objective = breachObjective(breach, maxWeight);
    if (openObjectives.has(objective)) {
      skipped += 1;
      continue;
    }
    const context: Json = {
      skill: "concentration_review",
      evidence: {
        symbol: breach.symbol,
        weight: breach.weight,
        value: breach.value,
        overByValue: breach.overByValue,
        portfolioTotal: review.total,
        maxWeight,
      },
    };
    const { data: task, error } = await supabase
      .from("agent_tasks")
      .insert({ user_id: user.id, objective, status: "queued", context, source_skill: "concentration_review" })
      .select("id, objective")
      .single();
    if (error || !task) continue;
    await supabase.from("agent_task_activity").insert({
      task_id: task.id,
      user_id: user.id,
      kind: "status_change",
      detail: { from: null, to: "queued", by: "concentration_review" },
    });
    created.push({ id: task.id, objective: task.objective });
  }

  return NextResponse.json({
    total: sumBy(positions, (p) => p.value),
    breaches: review.breaches.length,
    created,
    skipped,
  });
}
