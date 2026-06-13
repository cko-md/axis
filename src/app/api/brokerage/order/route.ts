import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBrokerageCreds } from "../status/route";

const orderSchema = z.object({
  symbol: z.string().min(1).max(12),
  side: z.enum(["buy", "sell"]),
  // notional ($) OR quantity (shares); at least one required
  notional: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  type: z.enum(["market", "limit"]).default("market"),
  limit_price: z.number().positive().optional(),
});

/**
 * Order routing scaffold for Public.com (or a generic brokerage).
 *
 * Without keys: returns { routed: false, mode: "log" } (200) so the client can
 * record the intended trade to fund_transactions locally without pretending an
 * execution happened. This is the graceful setup-state.
 *
 * With keys: this is where the real Public.com order placement call would go.
 * Trades are never auto-executed without an explicit confirmed request body.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_ORDER", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!parsed.data.notional && !parsed.data.quantity) {
    return NextResponse.json(
      { error: "MISSING_SIZE", message: "Provide notional or quantity." },
      { status: 400 },
    );
  }

  const creds = getBrokerageCreds();
  if (!creds) {
    return NextResponse.json({
      routed: false,
      mode: "log",
      message:
        "No brokerage connected. Order captured for your ledger only — connect Public.com to route it.",
      order: parsed.data,
    });
  }

  // --- Live routing would go here ---
  // const res = await fetch("https://api.public.com/...", {
  //   method: "POST",
  //   headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
  //   body: JSON.stringify({ accountId: creds.accountId, ...parsed.data }),
  // });
  // For now, signal that routing is configured but not yet wired to live execution.
  return NextResponse.json({
    routed: false,
    mode: "configured",
    message:
      "Brokerage credentials detected. Live order routing is not enabled in this build — order captured to your ledger.",
    order: parsed.data,
  });
}
