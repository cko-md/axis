const PLAID_API_VERSION = "2020-09-14";

type PlaidCredentials = { clientId: string; secret: string; env: string };

function host(env: string) {
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function boundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown> | null> {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    return plainRecord(value) ? value : null;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}

export async function plaidRequest(
  credentials: PlaidCredentials,
  endpoint: string,
  accessToken: string,
  request: Record<string, unknown>,
  options: {
    deadline: number;
    expectedItemId: string;
    maxResponseBytes: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  if (
    "client_id" in request
    || "secret" in request
    || "access_token" in request
  ) throw new Error("PLAID_RESERVED_REQUEST_FIELD");
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) throw new Error("PLAID_DEADLINE_EXCEEDED");
  let response: Response;
  try {
    response = await fetch(`${host(credentials.env)}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Plaid-Version": PLAID_API_VERSION,
      },
      body: JSON.stringify({
        ...request,
        client_id: credentials.clientId,
        secret: credentials.secret,
        access_token: accessToken,
      }),
      cache: "no-store",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(remaining, 8_000))])
        : AbortSignal.timeout(Math.min(remaining, 8_000)),
    });
  } catch {
    throw new Error("PLAID_REQUEST_UNAVAILABLE");
  }
  const body = await boundedJson(response, options.maxResponseBytes);
  if (!response.ok) {
    const error = new Error("PLAID_PROVIDER_REJECTED") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (
    !body
    || typeof body.request_id !== "string"
    || body.request_id.length < 1
    || body.request_id.length > 256
    || !plainRecord(body.item)
    || body.item.item_id !== options.expectedItemId
  ) throw new Error("PLAID_RESPONSE_INVALID");
  return body;
}

export function isPlainPlaidRecord(value: unknown): value is Record<string, unknown> {
  return plainRecord(value);
}
