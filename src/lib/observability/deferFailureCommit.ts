/**
 * Give browser navigation/pagehide and React effect cleanup one macrotask to
 * invalidate an operation before committing user-visible error state or a
 * Sentry event. This does not classify errors by their mutable name/message;
 * callers must re-check their exact operation identity after the delay.
 */
export function deferFailureCommit(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
