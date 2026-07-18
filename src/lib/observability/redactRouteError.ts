import { NextResponse } from "next/server";
import { captureRouteError } from "./captureRouteError";

type SafeTag = string | number | boolean | null | undefined;

type RedactRouteErrorOptions = {
  route: string;
  operation?: string;
  area?: string;
  provider?: string;
  status?: number;
  code?: string;
  /** Client-safe message. Never include raw error/DB detail here. */
  message?: string;
  tags?: Record<string, SafeTag>;
};

/**
 * Capture the real error server-side (Sentry, via captureRouteError) and return a
 * client-safe JSON response that does NOT leak internal error detail — e.g. raw
 * Postgres/PostgREST messages, which previously reached clients via
 * `NextResponse.json({ error: error.message }, { status: 500 })`.
 *
 * The response shape stays `{ error: string }` so existing clients are unaffected;
 * only the message content is redacted to a generic, safe string.
 */
export function redactRouteError(
  error: unknown,
  opts: RedactRouteErrorOptions,
): NextResponse {
  const status = opts.status ?? 500;
  captureRouteError(error, {
    route: opts.route,
    operation: opts.operation ?? "request",
    ...(opts.area ? { area: opts.area } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    status,
    ...(opts.code ? { code: opts.code } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
  });
  return NextResponse.json(
    { error: opts.message ?? "Internal server error" },
    { status },
  );
}
