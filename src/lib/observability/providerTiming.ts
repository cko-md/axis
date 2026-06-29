import * as Sentry from "@sentry/nextjs";

type SafeValue = string | number | boolean | null | undefined;

type ProviderTimingOptions = {
  area: string;
  provider: string;
  operation: string;
  transport?: string;
  timeoutMs?: number;
  slowMs?: number;
  tags?: Record<string, SafeValue>;
};

type ProviderFailure = {
  code?: string;
  message?: string;
  status?: number;
};

export class ProviderTimeoutError extends Error {
  readonly code = "PROVIDER_TIMEOUT";
  readonly status = 504;

  constructor(provider: string, operation: string, timeoutMs: number) {
    super(`${provider} ${operation} timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

function nowMs() {
  return Date.now();
}

function safeTarget(input: string | URL | Request): string {
  try {
    const raw = input instanceof Request ? input.url : input.toString();
    const url = new URL(raw);
    return `${url.host}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "UnknownError";
}

function statusFrom(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as { status: unknown }).status;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function shouldCapture(failure: ProviderFailure) {
  if (failure.status !== undefined) return failure.status >= 500;
  return failure.code === "network" || failure.code === "provider_error" || failure.code === "rate_limited" || failure.code === "PROVIDER_TIMEOUT";
}

function timingData(
  opts: ProviderTimingOptions,
  durationMs: number,
  outcome: "ok" | "error" | "slow",
  extra: Record<string, SafeValue> = {},
) {
  return {
    area: opts.area,
    provider: opts.provider,
    operation: opts.operation,
    ...(opts.transport ? { transport: opts.transport } : {}),
    durationMs,
    outcome,
    ...opts.tags,
    ...extra,
  };
}

function logTiming(label: string, data: Record<string, SafeValue>) {
  console.info(`[axis:${label}]`, JSON.stringify(data));
}

export function recordProviderFailure(
  opts: ProviderTimingOptions,
  failure: ProviderFailure,
  durationMs: number,
) {
  const data = timingData(opts, durationMs, "error", {
    code: failure.code,
    status: failure.status,
  });

  Sentry.addBreadcrumb({
    category: "provider.failure",
    level: shouldCapture(failure) ? "error" : "warning",
    message: `${opts.provider}.${opts.operation}`,
    data,
  });
  logTiming("provider", data);

  if (!shouldCapture(failure)) return;
  Sentry.captureException(new Error(failure.message ?? `${opts.provider} ${opts.operation} failed`), {
    tags: {
      area: opts.area,
      provider: opts.provider,
      operation: opts.operation,
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.status !== undefined ? { status: String(failure.status) } : {}),
    },
    contexts: { providerCall: data },
  });
}

export async function timedProviderOperation<T>(
  opts: ProviderTimingOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const slowMs = opts.slowMs ?? 2_500;
  const startedAt = nowMs();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new ProviderTimeoutError(opts.provider, opts.operation, timeoutMs)), timeoutMs);
  });

  try {
    const result = await Promise.race([operation(), timeoutPromise]);
    const durationMs = nowMs() - startedAt;
    if (durationMs >= slowMs) {
      const data = timingData(opts, durationMs, "slow");
      Sentry.addBreadcrumb({
        category: "provider.slow",
        level: "warning",
        message: `${opts.provider}.${opts.operation}`,
        data,
      });
      logTiming("provider", data);
    }
    return result;
  } catch (error) {
    const durationMs = nowMs() - startedAt;
    recordProviderFailure(
      opts,
      {
        code: error instanceof ProviderTimeoutError ? error.code : "network",
        message: error instanceof Error ? error.message : `${opts.provider} ${opts.operation} failed`,
        status: statusFrom(error),
      },
      durationMs,
    );
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function timedProviderFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  opts: ProviderTimingOptions,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const slowMs = opts.slowMs ?? 2_000;
  const startedAt = nowMs();

  try {
    const res = await fetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const durationMs = nowMs() - startedAt;
    if (durationMs >= slowMs) {
      const data = timingData(opts, durationMs, "slow", {
        status: res.status,
        target: safeTarget(input),
      });
      Sentry.addBreadcrumb({
        category: "provider.slow",
        level: "warning",
        message: `${opts.provider}.${opts.operation}`,
        data,
      });
      logTiming("provider", data);
    }

    if (!res.ok && res.status >= 500) {
      recordProviderFailure(
        opts,
        {
          code: "provider_error",
          message: `${opts.provider} ${opts.operation} returned ${res.status}`,
          status: res.status,
        },
        durationMs,
      );
    }

    return res;
  } catch (error) {
    const durationMs = nowMs() - startedAt;
    recordProviderFailure(
      opts,
      {
        code: errorName(error) === "TimeoutError" ? "PROVIDER_TIMEOUT" : "network",
        message: error instanceof Error ? error.message : `${opts.provider} ${opts.operation} request failed`,
        status: statusFrom(error),
      },
      durationMs,
    );
    throw error;
  }
}

export function logRouteTiming(
  route: string,
  startedAt: number,
  data: Record<string, SafeValue> = {},
) {
  logTiming("route", {
    route,
    durationMs: nowMs() - startedAt,
    ...data,
  });
}
