/**
 * Maps provider metadata to client-safe auth failure classes. Provider
 * messages are deliberately ignored because they can contain PII or tokens.
 */
export function authProviderFailureStatus(error: unknown): 400 | 503 {
  if (!error || typeof error !== "object") return 503;

  const status = "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
  if (status !== undefined && status > 0) return status >= 500 ? 503 : 400;

  const name = "name" in error && typeof error.name === "string"
    ? error.name
    : "";
  const code = "code" in error && typeof error.code === "string"
    ? error.code.toUpperCase()
    : "";
  if (
    name === "AuthRetryableFetchError"
    || status === 0
    || /NETWORK|TIMEOUT|UNAVAILABLE|INTERNAL|SERVER|FETCH|RETRYABLE/.test(code)
  ) {
    return 503;
  }
  return 400;
}
