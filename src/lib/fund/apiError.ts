import { NextResponse } from "next/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/** Record financial API failures without returning database/provider details. */
export function fundApiFailure(error: unknown, route: string, operation: string) {
  captureRouteError(error, { route, operation, area: "fund", status: 500 });
  return NextResponse.json({ error: "FUND_OPERATION_FAILED" }, { status: 500 });
}
