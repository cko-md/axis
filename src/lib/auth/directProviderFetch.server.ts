export const DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS = 8_000;
export const DIRECT_PROVIDER_EXCHANGE_MAX_BYTES = 64 * 1024;

export class DirectProviderResponseTooLargeError extends Error {
  readonly code = "DIRECT_PROVIDER_RESPONSE_TOO_LARGE";

  constructor() {
    super("Direct provider response exceeded the fixed byte limit");
    this.name = "DirectProviderResponseTooLargeError";
  }
}

async function boundedJsonBody<T>(
  response: Response,
  signal: AbortSignal,
): Promise<T | null> {
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    /^\d+$/.test(advertised) &&
    Number(advertised) > DIRECT_PROVIDER_EXCHANGE_MAX_BYTES
  ) {
    await response.body?.cancel();
    throw new DirectProviderResponseTooLargeError();
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DIRECT_PROVIDER_EXCHANGE_MAX_BYTES) {
        await reader.cancel();
        throw new DirectProviderResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (total === 0) return null;

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return null;
  }
}

export async function directProviderExchangeJson<T>(
  input: string | URL,
  init: RequestInit,
): Promise<{ response: Response; body: T | null }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Provider exchange timed out", "AbortError"));
    }, DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS);
  });
  const exchange = (async () => {
    const response = await fetch(input, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    return {
      response,
      body: await boundedJsonBody<T>(response, controller.signal),
    };
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
