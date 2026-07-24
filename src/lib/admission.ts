import { captureRouteError } from "@/lib/observability/captureRouteError";

export type AdmissionDecision =
  | { kind: "allowed" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "unavailable"; reason: "not_configured" | "malformed" | "timeout" | "backend" };

export type AdmissionPolicy = {
  name: string;
  limit: number;
  window: `${number} ${"s" | "m" | "h"}`;
  protected: boolean;
  globalGuard?: {
    name: string;
    subject: string;
    limit: number;
    window: `${number} ${"s" | "m" | "h"}`;
  };
};

export const ADMISSION_POLICIES = {
  mfaChallenge: { name: "mfa-challenge", limit: 10, window: "5 m", protected: true },
  mfaVerify: { name: "mfa-verify", limit: 5, window: "5 m", protected: true },
  passkeyRegister: { name: "passkey-register", limit: 10, window: "10 m", protected: true },
  providerGlobal: { name: "massive-provider", limit: 4, window: "1 m", protected: true },
  mutation: { name: "mutation", limit: 30, window: "1 m", protected: true },
  cost: { name: "cost", limit: 20, window: "1 m", protected: true },
  external: { name: "external", limit: 30, window: "1 m", protected: true },
  financial: { name: "financial", limit: 20, window: "1 m", protected: true },
} as const satisfies Record<string, AdmissionPolicy>;

const LOCAL_MAX_KEYS = 2_000;
const LOCAL_MAX_WINDOW_MS = 60 * 60 * 1_000;
const TIMEOUT_MS = 900;
const localStore = new Map<string, { count: number; resetAt: number; touchedAt: number }>();
let localSecret = "";

function hostedRuntime() {
  return process.env.VERCEL === "1"
    || Boolean(process.env.VERCEL_ENV)
    || process.env.NODE_ENV === "production";
}

function configuredRedis(): "configured" | "missing" | "malformed" {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return "missing";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname) return "malformed";
  } catch {
    return "malformed";
  }
  return "configured";
}

function windowMs(window: AdmissionPolicy["window"]): number {
  const match = /^(\d+) ([smh])$/.exec(window);
  if (!match) return LOCAL_MAX_WINDOW_MS;
  const value = Number(match[1]);
  return Math.min(
    value * (match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000),
    LOCAL_MAX_WINDOW_MS,
  );
}

function retryAfter(resetAt: number) {
  return Math.max(1, Math.min(3600, Math.ceil((resetAt - Date.now()) / 1_000)));
}

function pruneLocal(now: number) {
  for (const [key, entry] of localStore) {
    if (entry.resetAt <= now || localStore.size > LOCAL_MAX_KEYS) localStore.delete(key);
    if (localStore.size <= LOCAL_MAX_KEYS) break;
  }
}

async function hmacSubject(subject: string): Promise<string | null> {
  const secret = process.env.QUOTA_SUBJECT_SECRET?.trim()
    || (!hostedRuntime() ? (localSecret ||= crypto.randomUUID()) : "");
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(subject)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("ADMISSION_TIMEOUT")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function distributedLimit(
  key: string,
  policy: AdmissionPolicy,
): Promise<AdmissionDecision> {
  try {
    const [{ Ratelimit }, { Redis }] = await withTimeout(Promise.all([
      import("@upstash/ratelimit"),
      import("@upstash/redis"),
    ]));
    const limiter = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
      prefix: `axis:admission:${policy.name}`,
    });
    const result = await withTimeout(limiter.limit(key));
    return result.success
      ? { kind: "allowed" }
      : { kind: "limited", retryAfterSeconds: retryAfter(result.reset) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      kind: "unavailable",
      reason: message === "ADMISSION_TIMEOUT" ? "timeout" : "backend",
    };
  }
}

function localLimit(key: string, policy: AdmissionPolicy): AdmissionDecision {
  const now = Date.now();
  pruneLocal(now);
  const existing = localStore.get(key);
  if (!existing || existing.resetAt <= now) {
    localStore.set(key, {
      count: 1,
      resetAt: now + windowMs(policy.window),
      touchedAt: now,
    });
    return { kind: "allowed" };
  }
  existing.count += 1;
  existing.touchedAt = now;
  return existing.count <= policy.limit
    ? { kind: "allowed" }
    : { kind: "limited", retryAfterSeconds: retryAfter(existing.resetAt) };
}

async function evaluateAdmission(
  pseudonym: string,
  policy: AdmissionPolicy,
  redis: ReturnType<typeof configuredRedis>,
): Promise<AdmissionDecision> {
  if (redis === "configured") return distributedLimit(pseudonym, policy);
  if (hostedRuntime() && policy.protected) {
    return {
      kind: "unavailable",
      reason: redis === "missing" ? "not_configured" : "malformed",
    };
  }
  return localLimit(`${policy.name}:${pseudonym}`, policy);
}

function reportUnavailable(
  result: Extract<AdmissionDecision, { kind: "unavailable" }>,
  policy: AdmissionPolicy,
  redis: ReturnType<typeof configuredRedis>,
) {
  captureRouteError(new Error("Admission backend unavailable"), {
    route: "admission",
    operation: policy.name,
    area: "security",
    status: 503,
    code: `ADMISSION_${result.reason.toUpperCase()}`,
    tags: {
      policy: policy.name,
      backend: redis === "configured" ? "upstash" : "local",
    },
  });
}

export async function admit(
  subject: string,
  policy: AdmissionPolicy,
): Promise<AdmissionDecision> {
  const redis = configuredRedis();

  if (policy.globalGuard) {
    const guardPolicy: AdmissionPolicy = {
      name: policy.globalGuard.name,
      limit: policy.globalGuard.limit,
      window: policy.globalGuard.window,
      protected: policy.protected,
    };
    const guardPseudonym = await hmacSubject(policy.globalGuard.subject);
    if (!guardPseudonym) {
      const result = { kind: "unavailable", reason: "not_configured" } as const;
      reportUnavailable(result, guardPolicy, redis);
      return result;
    }
    const guardResult = await evaluateAdmission(guardPseudonym, guardPolicy, redis);
    if (guardResult.kind !== "allowed") {
      if (guardResult.kind === "unavailable") {
        reportUnavailable(guardResult, guardPolicy, redis);
      }
      return guardResult;
    }
  }

  const pseudonym = await hmacSubject(subject);
  if (!pseudonym) {
    const result = { kind: "unavailable", reason: "not_configured" } as const;
    reportUnavailable(result, policy, redis);
    return result;
  }
  const result = await evaluateAdmission(pseudonym, policy, redis);
  if (result.kind === "unavailable") reportUnavailable(result, policy, redis);
  return result;
}

export function admissionResponse(decision: AdmissionDecision) {
  if (decision.kind === "allowed") return null;
  if (decision.kind === "limited") {
    return new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(decision.retryAfterSeconds),
      },
    });
  }
  return new Response(JSON.stringify({ error: "ADMISSION_UNAVAILABLE" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

export function resetLocalAdmissionForTest() {
  localStore.clear();
  localSecret = "";
}
