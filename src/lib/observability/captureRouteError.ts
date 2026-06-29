import * as Sentry from "@sentry/nextjs";

type SafeTag = string | number | boolean | null | undefined;

type CaptureRouteErrorOptions = {
  route: string;
  operation: string;
  area?: string;
  provider?: string;
  transport?: string;
  status?: number;
  code?: string;
  tags?: Record<string, SafeTag>;
};

function shouldCapture(status?: number, code?: string) {
  if (status !== undefined) return status >= 500;
  return code !== "NOT_CONFIGURED" && code !== "UNAUTHORIZED" && code !== "NOT_FOUND" && code !== "INVALID_QUERY";
}

function toError(error: unknown, fallback: string) {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : fallback);
}

function normalizeTags(tags: Record<string, SafeTag>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== null && entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

export function captureRouteError(error: unknown, opts: CaptureRouteErrorOptions) {
  const tags = normalizeTags({
    route: opts.route,
    operation: opts.operation,
    ...(opts.area ? { area: opts.area } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.transport ? { transport: opts.transport } : {}),
    ...(opts.status !== undefined ? { status: String(opts.status) } : {}),
    ...(opts.code ? { code: opts.code } : {}),
    ...opts.tags,
  });

  Sentry.addBreadcrumb({
    category: "route.error",
    level: shouldCapture(opts.status, opts.code) ? "error" : "warning",
    message: `${opts.route}.${opts.operation}`,
    data: tags,
  });

  if (!shouldCapture(opts.status, opts.code)) return;

  Sentry.captureException(toError(error, `${opts.route} ${opts.operation} failed`), {
    tags,
  });
}
