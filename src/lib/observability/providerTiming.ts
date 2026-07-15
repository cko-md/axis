import * as Sentry from "@sentry/nextjs";

type SafeValue = string | number | boolean | null | undefined;

type ProviderTimingOptions = {
  area: string;
  provider: string;
  operation: string;
  transport?: string;
  captureFailures?: boolean;
  timeoutMs?: number;
  slowMs?: number;
  retry?: ProviderRetryOptions;
  tags?: Record<string, SafeValue>;
};

type ProviderFailure = {
  code?: string;
  message?: string;
  status?: number;
};

type ProviderRetryOptions = {
  /** Total attempts including the first try. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  statuses?: number[];
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function retryPolicy(opts: ProviderTimingOptions): Required<Omit<ProviderRetryOptions, "sleep">> & Pick<ProviderRetryOptions, "sleep"> {
  return {
    maxAttempts: Math.max(1, Math.floor(opts.retry?.maxAttempts ?? 1)),
    baseDelayMs: Math.max(0, opts.retry?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, opts.retry?.maxDelayMs ?? 2_000),
    statuses: opts.retry?.statuses ?? [...DEFAULT_RETRY_STATUSES],
    sleep: opts.retry?.sleep,
  };
}

export function retryDelayMs(attempt: number, baseDelayMs = 250, maxDelayMs = 2_000): number {
  if (attempt <= 0 || baseDelayMs <= 0 || maxDelayMs <= 0) return 0;
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function retryableStatus(status: number, statuses: number[]): boolean {
  return statuses.includes(status);
}

function retryableError(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError) return true;
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError" || name === "TypeError" || name === "Error";
}

async function sleepMs(ms: number, sleeper?: (ms: number) => Promise<void>) {
  if (ms <= 0) return;
  if (sleeper) return sleeper(ms);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function recordProviderRetry(
  opts: ProviderTimingOptions,
  attempt: number,
  delayMs: number,
  extra: Record<string, SafeValue>,
) {
  const data = {
    area: opts.area,
    provider: opts.provider,
    operation: opts.operation,
    ...(opts.transport ? { transport: opts.transport } : {}),
    attempt,
    delayMs,
    ...opts.tags,
    ...extra,
  };
  Sentry.addBreadcrumb({
    category: "provider.retry",
    level: "info",
    message: `${opts.provider}.${opts.operation}`,
    data,
  });
  logTiming("provider-retry", data);
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

  if (opts.captureFailures === false || !shouldCapture(failure)) return;
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
  const policy = retryPolicy(opts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
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

      if (
        !res.ok &&
        attempt < policy.maxAttempts &&
        retryableStatus(res.status, policy.statuses)
      ) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const delayMs = Math.min(
          policy.maxDelayMs,
          Math.max(retryDelayMs(attempt, policy.baseDelayMs, policy.maxDelayMs), retryAfterMs ?? 0),
        );
        recordProviderRetry(opts, attempt, delayMs, { status: res.status, target: safeTarget(input) });
        await sleepMs(delayMs, policy.sleep);
        continue;
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
      lastError = error;
      const durationMs = nowMs() - startedAt;
      const code = errorName(error) === "TimeoutError" ? "PROVIDER_TIMEOUT" : "network";
      if (attempt < policy.maxAttempts && retryableError(error)) {
        const delayMs = retryDelayMs(attempt, policy.baseDelayMs, policy.maxDelayMs);
        recordProviderRetry(opts, attempt, delayMs, { code, target: safeTarget(input) });
        await sleepMs(delayMs, policy.sleep);
        continue;
      }
      recordProviderFailure(
        opts,
        {
          code,
          message: error instanceof Error ? error.message : `${opts.provider} ${opts.operation} request failed`,
          status: statusFrom(error),
        },
        durationMs,
      );
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${opts.provider} ${opts.operation} request failed`);
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
