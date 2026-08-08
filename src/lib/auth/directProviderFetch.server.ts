export const DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS = 8_000;

export async function directProviderExchangeFetch(
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS,
  );
  try {
    return await fetch(input, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
