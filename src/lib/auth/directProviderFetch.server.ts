export const DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS = 8_000;

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
    if (!response.ok) return { response, body: null };
    try {
      return { response, body: await response.json() as T };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return { response, body: null };
    }
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
