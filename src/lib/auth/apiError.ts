import { NextResponse } from "next/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/** Record auth failures safely; never return provider or database diagnostics. */
export function authApiFailure(error: unknown, route: string, operation: string, status = 500) {
  captureRouteError(error, { route, operation, area: "auth", status });
  return NextResponse.json({ error: "AUTH_OPERATION_FAILED" }, { status });
}
